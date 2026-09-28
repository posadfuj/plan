/**
 * Servicio de ledger: única puerta para modificar saldos.
 *
 * Cada operación corre en UNA transacción limitada al negocio (RLS) y:
 *  1. bloquea la membresía (FOR UPDATE) → las operaciones sobre un mismo cliente se serializan;
 *  2. si la clave de idempotencia ya existe, devuelve el resultado original sin repetir nada;
 *  3. aplica el motor puro de @aiment/core;
 *  4. escribe movimientos (nunca edita el pasado), actualiza el saldo materializado,
 *     publica eventos en el outbox y registra auditoría de lo sensible.
 */
import {
  checkLimits,
  computeEarn,
  computeGoal,
  decideRedeem,
  decideVoid,
  LoyaltyError,
  parseRule,
  planWelcome,
  validateAdjustment,
  type Rule,
} from '@aiment/core';
import { schema, withTenantTx, type Db, type Tx } from '@aiment/db';
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  assertIdempotencyKey,
  ServiceError,
  type EarnedRewardDTO,
  type EntryDTO,
  type MembershipState,
  type OperationResult,
  type Operator,
} from './types';

const {
  memberships,
  loyaltyPrograms,
  programRuleVersions,
  organizations,
  ledgerEntries,
  earnedRewards,
  rewards,
  redemptions,
  eventOutbox,
  auditLogs,
} = schema;

type LedgerKind = (typeof schema.ledgerKind.enumValues)[number];
type LedgerRow = typeof ledgerEntries.$inferSelect;

const notFound = () => new ServiceError(404, 'not_found', 'Recurso no encontrado');
const keyReused = () =>
  new ServiceError(409, 'idempotency_key_reused', 'Esta clave de idempotencia ya se usó para otra operación');

const reversal = alias(ledgerEntries, 'reversal');
/**
 * Condición: el movimiento no fue anulado. Referencia explícita a la fila externa ("ledger_entries")
 * para que la subconsulta correlacionada no compare contra su propia tabla.
 */
const notReversed = () =>
  sql`not exists (select 1 from app.ledger_entries r where r.reverses_entry_id = "ledger_entries"."id")`;

// ---------------------------------------------------------------------------
// Contexto de la membresía (bloqueada)
// ---------------------------------------------------------------------------
interface MembershipContext {
  membership: typeof memberships.$inferSelect;
  rule: Rule;
  programId: string;
  programStatus: string;
  timezone: string;
}

async function lockMembership(tx: Tx, orgId: string, membershipId: string): Promise<MembershipContext> {
  // Bloqueo de la fila (consulta de una sola tabla: Postgres no admite "FOR UPDATE OF esquema.tabla").
  const [locked] = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.id, membershipId), eq(memberships.organizationId, orgId)))
    .for('update');
  if (!locked) throw notFound();
  const [row] = await tx
    .select({
      membership: memberships,
      mode: loyaltyPrograms.mode,
      programStatus: loyaltyPrograms.status,
      version: programRuleVersions,
      timezone: organizations.timezone,
    })
    .from(memberships)
    .innerJoin(loyaltyPrograms, eq(loyaltyPrograms.id, memberships.programId))
    .innerJoin(programRuleVersions, eq(programRuleVersions.id, loyaltyPrograms.currentVersionId))
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(and(eq(memberships.id, membershipId), eq(memberships.organizationId, orgId)));
  if (!row) throw notFound();
  const v = row.version;
  const rule = parseRule(
    row.mode,
    {
      earnRule: v.earnRule,
      goal: v.goal,
      welcomeBonus: v.welcomeBonus,
      limits: v.limits,
      expirationMonths: v.expirationMonths,
    },
    v.id,
  );
  return {
    membership: row.membership,
    rule,
    programId: row.membership.programId,
    programStatus: row.programStatus,
    timezone: row.timezone,
  };
}

function assertActive(ctx: MembershipContext) {
  if (ctx.membership.status !== 'active' || ctx.programStatus !== 'active')
    throw new LoyaltyError('membership_inactive', { status: ctx.membership.status });
}

// ---------------------------------------------------------------------------
// Lectura del estado y reconstrucción de respuestas (replay)
// ---------------------------------------------------------------------------
const entryCols = {
  id: ledgerEntries.id,
  kind: ledgerEntries.kind,
  delta: ledgerEntries.delta,
  balanceAfter: ledgerEntries.balanceAfter,
  createdAt: ledgerEntries.createdAt,
  reversesEntryId: ledgerEntries.reversesEntryId,
  causedByEntryId: ledgerEntries.causedByEntryId,
};
const earnedCols = {
  id: earnedRewards.id,
  rewardId: earnedRewards.rewardId,
  name: rewards.name,
  source: earnedRewards.source,
  status: earnedRewards.status,
  expiresAt: earnedRewards.expiresAt,
};

export async function getMembershipState(
  tx: Tx,
  orgId: string,
  membershipId: string,
): Promise<MembershipState> {
  const [m] = await tx
    .select({
      id: memberships.id,
      balance: memberships.balance,
      lifetimeEarned: memberships.lifetimeEarned,
      status: memberships.status,
      firstValidatedAt: memberships.firstValidatedAt,
      lastActivityAt: memberships.lastActivityAt,
    })
    .from(memberships)
    .where(and(eq(memberships.id, membershipId), eq(memberships.organizationId, orgId)));
  if (!m) throw notFound();
  const available = await tx
    .select(earnedCols)
    .from(earnedRewards)
    .innerJoin(rewards, eq(rewards.id, earnedRewards.rewardId))
    .where(
      and(
        eq(earnedRewards.membershipId, membershipId),
        eq(earnedRewards.organizationId, orgId),
        eq(earnedRewards.status, 'available'),
      ),
    )
    .orderBy(asc(earnedRewards.createdAt));
  return { ...m, availableRewards: available };
}

async function earnedRewardsFor(tx: Tx, orgId: string, sourceEntryIds: string[]): Promise<EarnedRewardDTO[]> {
  if (!sourceEntryIds.length) return [];
  return tx
    .select(earnedCols)
    .from(earnedRewards)
    .innerJoin(rewards, eq(rewards.id, earnedRewards.rewardId))
    .where(and(eq(earnedRewards.organizationId, orgId), inArray(earnedRewards.sourceEntryId, sourceEntryIds)))
    .orderBy(asc(earnedRewards.createdAt));
}

/** Si la clave ya fue usada en el ledger, devuelve la operación original (o 409 si era otra operación). */
async function replayLedgerOperation(
  tx: Tx,
  orgId: string,
  key: string,
  expect: {
    operation: OperationResult['operation'];
    membershipId: string;
    kind: LedgerKind;
    reversesEntryId?: string;
  },
): Promise<OperationResult | null> {
  const rows = await tx
    .select({
      ...entryCols,
      membershipId: ledgerEntries.membershipId,
      idempotencyKey: ledgerEntries.idempotencyKey,
    })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.organizationId, orgId),
        // Prefijo exacto (no LIKE: '_' es comodín y las claves pueden contenerlo).
        or(
          eq(ledgerEntries.idempotencyKey, key),
          sql`starts_with(${ledgerEntries.idempotencyKey}, ${`${key}#`})`,
        ),
      ),
    )
    .orderBy(asc(ledgerEntries.createdAt), asc(ledgerEntries.idempotencyKey));
  const primary = rows.find((r) => r.idempotencyKey === key);
  if (!primary) return null;
  if (
    primary.membershipId !== expect.membershipId ||
    primary.kind !== expect.kind ||
    (expect.reversesEntryId !== undefined && primary.reversesEntryId !== expect.reversesEntryId)
  )
    throw keyReused();

  const ids = rows.map((r) => r.id);
  const reversedIds = rows.map((r) => r.reversesEntryId).filter((x): x is string => !!x);
  const [redemption] = await tx
    .select({ id: redemptions.id, rewardId: redemptions.rewardId, status: redemptions.status })
    .from(redemptions)
    .where(and(eq(redemptions.organizationId, orgId), eq(redemptions.idempotencyKey, key)));
  return {
    operation: expect.operation,
    replayed: true,
    entries: rows.map(({ membershipId: _m, idempotencyKey: _k, ...e }) => e),
    earnedRewards: await earnedRewardsFor(tx, orgId, [...ids, ...reversedIds]),
    redemption: redemption ?? null,
    overriddenLimits: [],
    membership: await getMembershipState(tx, orgId, expect.membershipId),
  };
}

// ---------------------------------------------------------------------------
// Escritura
// ---------------------------------------------------------------------------
interface Writer {
  tx: Tx;
  orgId: string;
  ctx: MembershipContext;
  operator: Operator | null;
  now: Date;
  balance: number;
  entries: EntryDTO[];
}

async function writeEntry(
  w: Writer,
  input: {
    kind: LedgerKind;
    delta: number;
    key: string;
    actor?: 'operator' | 'system';
    amountCents?: number | null;
    reason?: string | null;
    reversesEntryId?: string | null;
    causedByEntryId?: string | null;
  },
): Promise<EntryDTO> {
  w.balance += input.delta;
  const byOperator = input.actor !== 'system' && w.operator;
  const [row] = await w.tx
    .insert(ledgerEntries)
    .values({
      organizationId: w.orgId,
      membershipId: w.ctx.membership.id,
      branchId: w.operator?.branchId ?? null,
      kind: input.kind,
      delta: input.delta,
      amountMoney: input.amountCents != null ? (input.amountCents / 100).toFixed(2) : null,
      ruleVersionId: w.ctx.rule.id,
      actorType: byOperator ? w.operator!.actorType : 'system',
      actorId: byOperator ? w.operator!.orgUserId : null,
      deviceId: byOperator ? (w.operator!.deviceId ?? null) : null,
      reason: input.reason ?? null,
      reversesEntryId: input.reversesEntryId ?? null,
      causedByEntryId: input.causedByEntryId ?? null,
      idempotencyKey: input.key,
      balanceAfter: w.balance,
      createdAt: w.now,
    })
    .returning(entryCols);
  w.entries.push(row!);
  return row!;
}

async function goalReward(tx: Tx, orgId: string, programId: string) {
  const [r] = await tx
    .select({ id: rewards.id, validityDays: rewards.validityDays })
    .from(rewards)
    .where(
      and(
        eq(rewards.organizationId, orgId),
        eq(rewards.programId, programId),
        eq(rewards.kind, 'goal'),
        eq(rewards.active, true),
      ),
    )
    .orderBy(asc(rewards.sortOrder))
    .limit(1);
  if (!r)
    throw new LoyaltyError(
      'reward_not_available',
      { reason: 'goal_reward_missing' },
      'El programa no tiene configurado el premio de la meta',
    );
  return r;
}

async function grantReward(
  w: Writer,
  reward: { id: string; validityDays: number | null },
  source: 'goal' | 'welcome',
  sourceEntryId: string,
) {
  const [row] = await w.tx
    .insert(earnedRewards)
    .values({
      organizationId: w.orgId,
      membershipId: w.ctx.membership.id,
      rewardId: reward.id,
      source,
      sourceEntryId,
      status: 'available',
      expiresAt: reward.validityDays ? new Date(w.now.getTime() + reward.validityDays * 86_400_000) : null,
      createdAt: w.now,
    })
    .returning({ id: earnedRewards.id });
  return row!.id;
}

/** Convierte sellos en premios mientras el saldo alcance la meta (con arrastre). */
async function applyGoal(w: Writer, key: string, causedByEntryId: string): Promise<string[]> {
  const { rewards: count } = computeGoal(w.balance, w.ctx.rule.goal);
  if (!count) return [];
  const reward = await goalReward(w.tx, w.orgId, w.ctx.programId);
  const granted: string[] = [];
  for (let i = 1; i <= count; i++) {
    const convert = await writeEntry(w, {
      kind: 'convert',
      delta: -w.ctx.rule.goal!,
      key: `${key}#convert-${i}`,
      actor: 'system',
      causedByEntryId,
    });
    granted.push(await grantReward(w, reward, 'goal', convert.id));
  }
  return granted;
}

async function saveMembership(
  w: Writer,
  patch: { lifetimeDelta?: number; firstValidatedAt?: Date | null; touch?: boolean },
) {
  await w.tx
    .update(memberships)
    .set({
      balance: w.balance,
      lifetimeEarned: sql`${memberships.lifetimeEarned} + ${patch.lifetimeDelta ?? 0}`,
      ...(patch.firstValidatedAt !== undefined ? { firstValidatedAt: patch.firstValidatedAt } : {}),
      ...(patch.touch !== false ? { lastActivityAt: w.now } : {}),
      version: sql`${memberships.version} + 1`,
    })
    .where(and(eq(memberships.id, w.ctx.membership.id), eq(memberships.organizationId, w.orgId)));
}

async function emit(
  tx: Tx,
  orgId: string,
  membershipId: string,
  type: string,
  payload: Record<string, unknown>,
) {
  await tx.insert(eventOutbox).values({ organizationId: orgId, type, aggregateId: membershipId, payload });
}

async function audit(
  tx: Tx,
  orgId: string,
  operator: Operator | null,
  action: string,
  entityType: string,
  entityId: string,
  after: Record<string, unknown>,
  before?: Record<string, unknown>,
) {
  await tx.insert(auditLogs).values({
    organizationId: orgId,
    actorType: operator?.actorType ?? 'system',
    actorId: operator?.orgUserId ?? null,
    action,
    entityType,
    entityId,
    before: before ?? null,
    after,
  });
}

function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 3 && e; i++) {
    if (typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Ejecuta una operación; si choca con una clave de idempotencia usada en paralelo (carrera),
 * reintenta una vez: la segunda ejecución encuentra la operación original y la devuelve.
 */
async function withRetryOnConflict<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    return fn();
  }
}

// ---------------------------------------------------------------------------
// Operaciones públicas
// ---------------------------------------------------------------------------
export interface EarnInput {
  membershipId: string;
  amount?: number | string | null;
  /** Solo dueño/admin (o trabajador con PIN del dueño, semana 4): permite superar un límite, queda auditado. */
  overrideReason?: string | null;
  operator: Operator;
  idempotencyKey: string;
  now?: Date;
}

export async function earn(db: Db, orgId: string, input: EarnInput): Promise<OperationResult> {
  assertIdempotencyKey(input.idempotencyKey);
  const key = input.idempotencyKey;
  const now = input.now ?? new Date();

  return withRetryOnConflict(() =>
    withTenantTx(db, orgId, async (tx) => {
      const ctx = await lockMembership(tx, orgId, input.membershipId);
      const replay = await replayLedgerOperation(tx, orgId, key, {
        operation: 'earn',
        membershipId: ctx.membership.id,
        kind: 'earn',
      });
      if (replay) return replay;
      assertActive(ctx);

      const { units, amountCents } = computeEarn(ctx.rule, { amount: input.amount });

      // Límites: última suma vigente de la membresía y unidades del usuario hoy (zona horaria del negocio).
      const [last] = await tx
        .select({ at: ledgerEntries.createdAt })
        .from(ledgerEntries)
        .where(
          and(
            eq(ledgerEntries.organizationId, orgId),
            eq(ledgerEntries.membershipId, ctx.membership.id),
            eq(ledgerEntries.kind, 'earn'),
            notReversed(),
          ),
        )
        .orderBy(desc(ledgerEntries.createdAt))
        .limit(1);
      const [today] = await tx
        .select({ units: sql<number>`coalesce(sum(${ledgerEntries.delta}), 0)::int` })
        .from(ledgerEntries)
        .where(
          and(
            eq(ledgerEntries.organizationId, orgId),
            eq(ledgerEntries.actorId, input.operator.orgUserId),
            eq(ledgerEntries.kind, 'earn'),
            notReversed(),
            sql`${ledgerEntries.createdAt} >= (date_trunc('day', ${now.toISOString()}::timestamptz at time zone ${ctx.timezone}) at time zone ${ctx.timezone})`,
          ),
        );
      // El tope diario es un control sobre la caja; dueño y admin no lo tienen (el cooldown sí aplica a todos).
      const limits =
        input.operator.actorType === 'staff'
          ? ctx.rule.limits
          : { ...ctx.rule.limits, staff_daily_units: undefined };
      const violations = checkLimits(limits, {
        units,
        amountCents,
        lastEarnAt: last?.at ?? null,
        actorUnitsToday: today?.units ?? 0,
        now,
      });
      const override = input.overrideReason?.trim();
      if (violations.length && !(override && input.operator.canOverrideLimits)) {
        const first = violations[0]!;
        throw new LoyaltyError(
          first.code,
          { violations, overridable: input.operator.canOverrideLimits },
          first.message,
        );
      }
      if (violations.length && override && override.length < 5) throw new LoyaltyError('reason_required');

      const w: Writer = {
        tx,
        orgId,
        ctx,
        operator: input.operator,
        now,
        balance: ctx.membership.balance,
        entries: [],
      };
      const earnEntry = await writeEntry(w, { kind: 'earn', delta: units, key, amountCents });
      let lifetimeDelta = units;
      const granted: string[] = [];

      // Bono de bienvenida: solo en la primera visita validada (nunca al registrarse).
      const isFirst = ctx.membership.firstValidatedAt === null;
      const welcome = planWelcome(ctx.rule.welcomeBonus, isFirst);
      if (welcome?.type === 'units') {
        await writeEntry(w, {
          kind: 'bonus',
          delta: welcome.units,
          key: `${key}#welcome`,
          actor: 'system',
          causedByEntryId: earnEntry.id,
        });
        lifetimeDelta += welcome.units;
      } else if (welcome?.type === 'reward') {
        const [gift] = await tx
          .select({ id: rewards.id, validityDays: rewards.validityDays, active: rewards.active })
          .from(rewards)
          .where(
            and(
              eq(rewards.id, welcome.reward_id),
              eq(rewards.organizationId, orgId),
              eq(rewards.kind, 'gift'),
            ),
          );
        if (gift?.active) granted.push(await grantReward(w, gift, 'welcome', earnEntry.id));
      }

      granted.push(...(await applyGoal(w, key, earnEntry.id)));
      await saveMembership(w, { lifetimeDelta, ...(isFirst ? { firstValidatedAt: now } : {}) });

      await emit(tx, orgId, ctx.membership.id, 'ledger.created', {
        entryId: earnEntry.id,
        kind: 'earn',
        units,
      });
      if (granted.length)
        await emit(tx, orgId, ctx.membership.id, 'reward.earned', {
          earnedRewardIds: granted,
          entryId: earnEntry.id,
        });
      if (violations.length)
        await audit(tx, orgId, input.operator, 'limits.overridden', 'ledger_entry', earnEntry.id, {
          violations: violations.map((v) => v.code),
          reason: override,
        });

      return {
        operation: 'earn',
        replayed: false,
        entries: w.entries,
        earnedRewards: await earnedRewardsFor(
          tx,
          orgId,
          w.entries.map((e) => e.id),
        ),
        redemption: null,
        overriddenLimits: violations.map((v) => v.code),
        membership: await getMembershipState(tx, orgId, ctx.membership.id),
      };
    }),
  );
}

export interface RedeemInput {
  membershipId: string;
  /** Premio ganado (meta de sellos o regalo). */
  earnedRewardId?: string | null;
  /** Premio de catálogo (programa de puntos). */
  rewardId?: string | null;
  operator: Operator;
  idempotencyKey: string;
  now?: Date;
}

export async function redeem(db: Db, orgId: string, input: RedeemInput): Promise<OperationResult> {
  assertIdempotencyKey(input.idempotencyKey);
  const key = input.idempotencyKey;
  const now = input.now ?? new Date();
  if (!input.earnedRewardId === !input.rewardId)
    throw new ServiceError(
      422,
      'invalid_request',
      'Indica el premio ganado o el premio del catálogo (uno solo)',
    );

  return withRetryOnConflict(() =>
    withTenantTx(db, orgId, async (tx) => {
      const ctx = await lockMembership(tx, orgId, input.membershipId);
      const [existing] = await tx
        .select()
        .from(redemptions)
        .where(and(eq(redemptions.organizationId, orgId), eq(redemptions.idempotencyKey, key)));
      if (existing) {
        if (existing.membershipId !== ctx.membership.id) throw keyReused();
        const entries = existing.ledgerEntryId
          ? await tx.select(entryCols).from(ledgerEntries).where(eq(ledgerEntries.id, existing.ledgerEntryId))
          : [];
        const earned = existing.earnedRewardId
          ? await tx
              .select(earnedCols)
              .from(earnedRewards)
              .innerJoin(rewards, eq(rewards.id, earnedRewards.rewardId))
              .where(eq(earnedRewards.id, existing.earnedRewardId))
          : [];
        return {
          operation: 'redeem',
          replayed: true,
          entries,
          earnedRewards: earned,
          redemption: { id: existing.id, rewardId: existing.rewardId, status: existing.status },
          overriddenLimits: [],
          membership: await getMembershipState(tx, orgId, ctx.membership.id),
        };
      }
      assertActive(ctx);
      const w: Writer = {
        tx,
        orgId,
        ctx,
        operator: input.operator,
        now,
        balance: ctx.membership.balance,
        entries: [],
      };

      let rewardId: string;
      let earnedRewardId: string | null = null;
      let ledgerEntryId: string | null = null;
      if (input.earnedRewardId) {
        await tx
          .select({ id: earnedRewards.id })
          .from(earnedRewards)
          .where(and(eq(earnedRewards.id, input.earnedRewardId), eq(earnedRewards.organizationId, orgId)))
          .for('update');
        const [er] = await tx
          .select({
            id: earnedRewards.id,
            rewardId: earnedRewards.rewardId,
            status: earnedRewards.status,
            expiresAt: earnedRewards.expiresAt,
            active: rewards.active,
          })
          .from(earnedRewards)
          .innerJoin(rewards, eq(rewards.id, earnedRewards.rewardId))
          .where(
            and(
              eq(earnedRewards.id, input.earnedRewardId),
              eq(earnedRewards.organizationId, orgId),
              eq(earnedRewards.membershipId, ctx.membership.id),
            ),
          );
        if (!er) throw notFound();
        decideRedeem(
          { type: 'earned', status: er.status, expiresAt: er.expiresAt, rewardActive: er.active },
          w.balance,
          now,
        );
        await tx
          .update(earnedRewards)
          .set({ status: 'redeemed', redeemedAt: now })
          .where(and(eq(earnedRewards.id, er.id), eq(earnedRewards.status, 'available')));
        rewardId = er.rewardId;
        earnedRewardId = er.id;
      } else {
        const [r] = await tx
          .select({ id: rewards.id, kind: rewards.kind, cost: rewards.cost, active: rewards.active })
          .from(rewards)
          .where(
            and(
              eq(rewards.id, input.rewardId!),
              eq(rewards.organizationId, orgId),
              eq(rewards.programId, ctx.programId),
            ),
          );
        if (!r) throw notFound();
        const { delta } = decideRedeem(
          { type: 'catalog', kind: r.kind, cost: r.cost, active: r.active },
          w.balance,
          now,
        );
        const entry = await writeEntry(w, { kind: 'redeem', delta, key });
        rewardId = r.id;
        ledgerEntryId = entry.id;
      }

      const [red] = await tx
        .insert(redemptions)
        .values({
          organizationId: orgId,
          membershipId: ctx.membership.id,
          rewardId,
          earnedRewardId,
          ledgerEntryId,
          branchId: input.operator.branchId ?? null,
          organizationUserId: input.operator.orgUserId,
          deviceId: input.operator.deviceId ?? null,
          idempotencyKey: key,
          createdAt: now,
        })
        .returning({ id: redemptions.id, rewardId: redemptions.rewardId, status: redemptions.status });
      await saveMembership(w, {});
      await emit(tx, orgId, ctx.membership.id, 'reward.redeemed', { redemptionId: red!.id, rewardId });

      return {
        operation: 'redeem',
        replayed: false,
        entries: w.entries,
        earnedRewards: earnedRewardId
          ? await tx
              .select(earnedCols)
              .from(earnedRewards)
              .innerJoin(rewards, eq(rewards.id, earnedRewards.rewardId))
              .where(eq(earnedRewards.id, earnedRewardId))
          : [],
        redemption: red!,
        overriddenLimits: [],
        membership: await getMembershipState(tx, orgId, ctx.membership.id),
      };
    }),
  );
}

export interface AdjustInput {
  membershipId: string;
  delta: number;
  reason: string;
  operator: Operator;
  idempotencyKey: string;
  now?: Date;
}

/** Ajuste manual (solo dueño/admin): siempre con motivo y auditado. Puede completar una meta. */
export async function adjust(db: Db, orgId: string, input: AdjustInput): Promise<OperationResult> {
  assertIdempotencyKey(input.idempotencyKey);
  const key = input.idempotencyKey;
  const now = input.now ?? new Date();

  return withRetryOnConflict(() =>
    withTenantTx(db, orgId, async (tx) => {
      const ctx = await lockMembership(tx, orgId, input.membershipId);
      const replay = await replayLedgerOperation(tx, orgId, key, {
        operation: 'adjust',
        membershipId: ctx.membership.id,
        kind: 'adjust',
      });
      if (replay) return replay;
      assertActive(ctx);
      validateAdjustment(input.delta, input.reason, ctx.membership.balance);

      const w: Writer = {
        tx,
        orgId,
        ctx,
        operator: input.operator,
        now,
        balance: ctx.membership.balance,
        entries: [],
      };
      const entry = await writeEntry(w, {
        kind: 'adjust',
        delta: input.delta,
        key,
        reason: input.reason.trim(),
      });
      const granted = input.delta > 0 ? await applyGoal(w, key, entry.id) : [];
      await saveMembership(w, {});
      await emit(tx, orgId, ctx.membership.id, 'ledger.created', { entryId: entry.id, kind: 'adjust' });
      if (granted.length)
        await emit(tx, orgId, ctx.membership.id, 'reward.earned', {
          earnedRewardIds: granted,
          entryId: entry.id,
        });
      await audit(tx, orgId, input.operator, 'ledger.adjusted', 'ledger_entry', entry.id, {
        delta: input.delta,
        reason: input.reason.trim(),
        balanceBefore: ctx.membership.balance,
        balanceAfter: w.balance,
      });

      return {
        operation: 'adjust',
        replayed: false,
        entries: w.entries,
        earnedRewards: await earnedRewardsFor(
          tx,
          orgId,
          w.entries.map((e) => e.id),
        ),
        redemption: null,
        overriddenLimits: [],
        membership: await getMembershipState(tx, orgId, ctx.membership.id),
      };
    }),
  );
}

export interface VoidInput {
  entryId: string;
  reason: string;
  operator: Operator;
  idempotencyKey: string;
  now?: Date;
}

/**
 * Anula un movimiento creando su reversa (nunca se edita el original). Revierte también lo que ese
 * movimiento generó: conversiones de meta (y sus premios, si no se usaron) y el bono de bienvenida.
 */
export async function voidEntry(db: Db, orgId: string, input: VoidInput): Promise<OperationResult> {
  assertIdempotencyKey(input.idempotencyKey);
  const key = input.idempotencyKey;
  const now = input.now ?? new Date();

  return withRetryOnConflict(() =>
    withTenantTx(db, orgId, async (tx) => {
      const [target] = await tx
        .select()
        .from(ledgerEntries)
        .where(and(eq(ledgerEntries.id, input.entryId), eq(ledgerEntries.organizationId, orgId)));
      if (!target) throw notFound();
      const ctx = await lockMembership(tx, orgId, target.membershipId);
      const replay = await replayLedgerOperation(tx, orgId, key, {
        operation: 'void',
        membershipId: ctx.membership.id,
        kind: 'reversal',
        reversesEntryId: target.id,
      });
      if (replay) return replay;

      const [reversed] = await tx
        .select({ id: reversal.id })
        .from(reversal)
        .where(and(eq(reversal.organizationId, orgId), eq(reversal.reversesEntryId, target.id)));
      const [latestOwn] = await tx
        .select({ id: ledgerEntries.id })
        .from(ledgerEntries)
        .where(
          and(
            eq(ledgerEntries.organizationId, orgId),
            eq(ledgerEntries.membershipId, ctx.membership.id),
            eq(ledgerEntries.actorId, input.operator.orgUserId),
            inArray(ledgerEntries.kind, ['earn', 'bonus', 'redeem', 'adjust']),
            notReversed(),
          ),
        )
        .orderBy(desc(ledgerEntries.createdAt))
        .limit(1);
      const effects: LedgerRow[] = await tx
        .select()
        .from(ledgerEntries)
        .where(
          and(
            eq(ledgerEntries.organizationId, orgId),
            eq(ledgerEntries.causedByEntryId, target.id),
            notReversed(),
          ),
        );
      const rewardSources = [target.id, ...effects.map((e) => e.id)];
      const affectedRewards = await tx
        .select({ id: earnedRewards.id, status: earnedRewards.status })
        .from(earnedRewards)
        .where(
          and(eq(earnedRewards.organizationId, orgId), inArray(earnedRewards.sourceEntryId, rewardSources)),
        )
        .for('update');

      decideVoid({
        entry: {
          kind: target.kind,
          delta: target.delta,
          actorId: target.actorId,
          createdAt: target.createdAt,
          alreadyReversed: !!reversed,
        },
        actor: {
          id: input.operator.orgUserId,
          canVoidAny: input.operator.canVoidAny,
          isLatestOwnEntry: latestOwn?.id === target.id,
        },
        sideEffects: {
          delta: effects.reduce((s, e) => s + e.delta, 0),
          redeemedRewards: affectedRewards.filter((r) => r.status === 'redeemed').length,
        },
        balance: ctx.membership.balance,
        reason: input.reason,
        now,
      });

      // Positivos primero: el saldo intermedio nunca baja del final (que decideVoid garantiza ≥ 0).
      const plan = [
        { original: target, key },
        ...effects.map((e, i) => ({ original: e, key: `${key}#effect-${i + 1}` })),
      ].sort((a, b) => a.original.delta - b.original.delta);
      const w: Writer = {
        tx,
        orgId,
        ctx,
        operator: input.operator,
        now,
        balance: ctx.membership.balance,
        entries: [],
      };
      for (const p of plan)
        await writeEntry(w, {
          kind: 'reversal',
          delta: -p.original.delta,
          key: p.key,
          reason: input.reason.trim(),
          reversesEntryId: p.original.id,
        });

      if (affectedRewards.length)
        await tx
          .update(earnedRewards)
          .set({ status: 'voided' })
          .where(
            and(
              inArray(
                earnedRewards.id,
                affectedRewards.map((r) => r.id),
              ),
              eq(earnedRewards.status, 'available'),
            ),
          );
      if (target.kind === 'redeem')
        await tx
          .update(redemptions)
          .set({ status: 'voided' })
          .where(and(eq(redemptions.organizationId, orgId), eq(redemptions.ledgerEntryId, target.id)));

      // Si se anuló la única visita validada, el bono de bienvenida vuelve a estar pendiente.
      let firstValidatedAt: Date | null | undefined;
      if (target.kind === 'earn') {
        const [otherEarn] = await tx
          .select({ id: ledgerEntries.id })
          .from(ledgerEntries)
          .where(
            and(
              eq(ledgerEntries.organizationId, orgId),
              eq(ledgerEntries.membershipId, ctx.membership.id),
              eq(ledgerEntries.kind, 'earn'),
              notReversed(),
            ),
          )
          .limit(1);
        if (!otherEarn) firstValidatedAt = null;
      }
      const lifetimeDelta = [target, ...effects]
        .filter((e) => e.kind === 'earn' || e.kind === 'bonus')
        .reduce((s, e) => s - e.delta, 0);
      await saveMembership(w, {
        lifetimeDelta,
        touch: false,
        ...(firstValidatedAt !== undefined ? { firstValidatedAt } : {}),
      });

      await emit(tx, orgId, ctx.membership.id, 'ledger.created', {
        entryId: w.entries.at(-1)!.id,
        kind: 'reversal',
      });
      await audit(tx, orgId, input.operator, 'ledger.voided', 'ledger_entry', target.id, {
        reason: input.reason.trim(),
        kind: target.kind,
        delta: target.delta,
        reversedEffects: effects.length,
        voidedRewards: affectedRewards.length,
      });

      return {
        operation: 'void',
        replayed: false,
        entries: w.entries,
        earnedRewards: await earnedRewardsFor(tx, orgId, rewardSources),
        redemption: null,
        overriddenLimits: [],
        membership: await getMembershipState(tx, orgId, ctx.membership.id),
      };
    }),
  );
}

export interface VoidRedemptionInput {
  redemptionId: string;
  reason: string;
  operator: Operator;
  idempotencyKey: string;
  now?: Date;
}

/**
 * Anula un canje. Si era de catálogo (descontó puntos), equivale a anular su movimiento.
 * Si era un premio ganado, el premio vuelve a estar disponible.
 */
export async function voidRedemption(
  db: Db,
  orgId: string,
  input: VoidRedemptionInput,
): Promise<OperationResult> {
  assertIdempotencyKey(input.idempotencyKey);
  const now = input.now ?? new Date();
  const [red] = await withTenantTx(db, orgId, (tx) =>
    tx
      .select()
      .from(redemptions)
      .where(and(eq(redemptions.id, input.redemptionId), eq(redemptions.organizationId, orgId))),
  );
  if (!red) throw notFound();
  if (red.ledgerEntryId) {
    const result = await voidEntry(db, orgId, { ...input, entryId: red.ledgerEntryId, now });
    return {
      ...result,
      operation: 'void_redemption',
      redemption: { id: red.id, rewardId: red.rewardId, status: 'voided' },
    };
  }

  return withTenantTx(db, orgId, async (tx) => {
    const ctx = await lockMembership(tx, orgId, red.membershipId);
    const [current] = await tx.select().from(redemptions).where(eq(redemptions.id, red.id)).for('update');
    const [previous] = await tx
      .select({ key: sql<string>`${auditLogs.after}->>'idempotencyKey'` })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.organizationId, orgId),
          eq(auditLogs.action, 'redemption.voided'),
          eq(auditLogs.entityId, red.id),
        ),
      );
    const result = (replayed: boolean): Promise<OperationResult> =>
      getMembershipState(tx, orgId, ctx.membership.id).then(async (membership) => ({
        operation: 'void_redemption',
        replayed,
        entries: [],
        earnedRewards: await tx
          .select(earnedCols)
          .from(earnedRewards)
          .innerJoin(rewards, eq(rewards.id, earnedRewards.rewardId))
          .where(eq(earnedRewards.id, red.earnedRewardId!)),
        redemption: { id: red.id, rewardId: red.rewardId, status: 'voided' },
        overriddenLimits: [],
        membership,
      }));
    if (current!.status === 'voided') {
      if (previous?.key === input.idempotencyKey) return result(true);
      throw new LoyaltyError('already_voided');
    }

    decideVoid({
      entry: {
        kind: 'redeem',
        delta: 0,
        actorId: current!.organizationUserId,
        createdAt: current!.createdAt,
        alreadyReversed: false,
      },
      actor: { id: input.operator.orgUserId, canVoidAny: input.operator.canVoidAny, isLatestOwnEntry: true },
      sideEffects: { delta: 0, redeemedRewards: 0 },
      balance: ctx.membership.balance,
      reason: input.reason,
      now,
    });
    await tx.update(redemptions).set({ status: 'voided' }).where(eq(redemptions.id, red.id));
    await tx
      .update(earnedRewards)
      .set({ status: 'available', redeemedAt: null })
      .where(and(eq(earnedRewards.id, red.earnedRewardId!), eq(earnedRewards.status, 'redeemed')));
    await tx
      .update(memberships)
      .set({ version: sql`${memberships.version} + 1` })
      .where(eq(memberships.id, ctx.membership.id));
    await emit(tx, orgId, ctx.membership.id, 'reward.redeemed', { redemptionId: red.id, voided: true });
    await audit(tx, orgId, input.operator, 'redemption.voided', 'redemption', red.id, {
      reason: input.reason.trim(),
      idempotencyKey: input.idempotencyKey,
      earnedRewardId: red.earnedRewardId,
    });
    return result(false);
  });
}

/**
 * Expiración por inactividad (job diario). Con `expiration_months = null` no hace nada (modo piloto).
 * Idempotente: la clave depende de la última actividad, así que reejecutarlo el mismo día no duplica.
 */
export async function expireInactive(
  db: Db,
  orgId: string,
  now = new Date(),
): Promise<{ expiredMemberships: number; expiredRewards: number }> {
  return withTenantTx(db, orgId, async (tx) => {
    const expiredRewards = await tx
      .update(earnedRewards)
      .set({ status: 'expired' })
      .where(
        and(
          eq(earnedRewards.organizationId, orgId),
          eq(earnedRewards.status, 'available'),
          sql`${earnedRewards.expiresAt} <= ${now.toISOString()}::timestamptz`,
        ),
      )
      .returning({ id: earnedRewards.id });

    const [program] = await tx
      .select({ months: programRuleVersions.expirationMonths })
      .from(loyaltyPrograms)
      .innerJoin(programRuleVersions, eq(programRuleVersions.id, loyaltyPrograms.currentVersionId))
      .where(and(eq(loyaltyPrograms.organizationId, orgId), eq(loyaltyPrograms.status, 'active')));
    if (!program?.months) return { expiredMemberships: 0, expiredRewards: expiredRewards.length };

    const candidates = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, orgId),
          sql`${memberships.balance} > 0`,
          sql`${memberships.lastActivityAt} <= ${now.toISOString()}::timestamptz - make_interval(months => ${program.months})`,
        ),
      );
    let count = 0;
    for (const c of candidates) {
      const ctx = await lockMembership(tx, orgId, c.id);
      if (ctx.membership.balance <= 0 || !ctx.membership.lastActivityAt) continue;
      const key = `expire-${ctx.membership.id}-${ctx.membership.lastActivityAt.getTime()}`;
      const [done] = await tx
        .select({ id: ledgerEntries.id })
        .from(ledgerEntries)
        .where(and(eq(ledgerEntries.organizationId, orgId), eq(ledgerEntries.idempotencyKey, key)));
      if (done) continue;
      const w: Writer = { tx, orgId, ctx, operator: null, now, balance: ctx.membership.balance, entries: [] };
      await writeEntry(w, {
        kind: 'expire',
        delta: -ctx.membership.balance,
        key,
        actor: 'system',
        reason: `Sin actividad por ${program.months} meses`,
      });
      await saveMembership(w, { touch: false });
      await emit(tx, orgId, ctx.membership.id, 'ledger.created', {
        entryId: w.entries[0]!.id,
        kind: 'expire',
      });
      count++;
    }
    return { expiredMemberships: count, expiredRewards: expiredRewards.length };
  });
}
