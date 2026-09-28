/**
 * Configuración del programa: versiones de regla y premios.
 * Cambiar una regla crea una versión nueva; los movimientos anteriores conservan la suya.
 */
import { LoyaltyError, parseRule, type RuleInput } from '@aiment/core';
import { schema, withTenantTx, type Db, type Tx } from '@aiment/db';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { ServiceError, type Operator } from './types';

const { loyaltyPrograms, programRuleVersions, rewards, auditLogs, eventOutbox } = schema;
type RewardKind = (typeof schema.rewardKind.enumValues)[number];

const notFound = () => new ServiceError(404, 'not_found', 'Recurso no encontrado');

async function activeProgram(tx: Tx, orgId: string, lock = false) {
  const q = tx
    .select()
    .from(loyaltyPrograms)
    .where(and(eq(loyaltyPrograms.organizationId, orgId), eq(loyaltyPrograms.status, 'active')));
  const [p] = lock ? await q.for('update') : await q;
  if (!p) throw new ServiceError(404, 'program_not_found', 'El negocio no tiene un programa activo');
  return p;
}

export async function getProgram(db: Db, orgId: string) {
  return withTenantTx(db, orgId, async (tx) => {
    const program = await activeProgram(tx, orgId);
    const [rule] = await tx
      .select()
      .from(programRuleVersions)
      .where(eq(programRuleVersions.id, program.currentVersionId!));
    const list = await tx
      .select()
      .from(rewards)
      .where(and(eq(rewards.organizationId, orgId), eq(rewards.programId, program.id)))
      .orderBy(asc(rewards.sortOrder), asc(rewards.createdAt));
    return {
      id: program.id,
      name: program.name,
      mode: program.mode,
      unitLabel: program.unitLabel,
      rule: rule
        ? {
            id: rule.id,
            version: rule.version,
            earnRule: rule.earnRule,
            goal: rule.goal,
            welcomeBonus: rule.welcomeBonus,
            limits: rule.limits,
            expirationMonths: rule.expirationMonths,
            createdAt: rule.createdAt,
          }
        : null,
      rewards: list.map((r) => ({
        id: r.id,
        kind: r.kind,
        name: r.name,
        description: r.description,
        cost: r.cost,
        validityDays: r.validityDays,
        active: r.active,
        sortOrder: r.sortOrder,
      })),
    };
  });
}

async function assertGiftReward(tx: Tx, orgId: string, programId: string, rewardId: string) {
  const [gift] = await tx
    .select({ id: rewards.id })
    .from(rewards)
    .where(
      and(
        eq(rewards.id, rewardId),
        eq(rewards.organizationId, orgId),
        eq(rewards.programId, programId),
        eq(rewards.kind, 'gift'),
        eq(rewards.active, true),
      ),
    );
  if (!gift)
    throw new LoyaltyError(
      'invalid_rule',
      { field: 'welcomeBonus' },
      'El regalo de bienvenida debe ser un premio de tipo regalo activo',
    );
}

/** Publica una nueva versión de la regla del programa (el modo sellos/puntos no cambia). */
export async function createRuleVersion(db: Db, orgId: string, operator: Operator, input: RuleInput) {
  return withTenantTx(db, orgId, async (tx) => {
    const program = await activeProgram(tx, orgId, true);
    const rule = parseRule(program.mode, input);
    if (rule.welcomeBonus.type === 'reward')
      await assertGiftReward(tx, orgId, program.id, rule.welcomeBonus.reward_id);

    const [prev] = await tx
      .select()
      .from(programRuleVersions)
      .where(eq(programRuleVersions.id, program.currentVersionId!));
    const [{ next }] = (await tx
      .select({ next: sql<number>`coalesce(max(${programRuleVersions.version}), 0)::int + 1` })
      .from(programRuleVersions)
      .where(eq(programRuleVersions.programId, program.id))) as [{ next: number }];
    const [created] = await tx
      .insert(programRuleVersions)
      .values({
        organizationId: orgId,
        programId: program.id,
        version: next,
        earnRule: rule.earnRule,
        goal: rule.goal,
        welcomeBonus: rule.welcomeBonus,
        limits: rule.limits,
        expirationMonths: rule.expirationMonths,
        createdBy: operator.orgUserId,
      })
      .returning();
    await tx
      .update(loyaltyPrograms)
      .set({ currentVersionId: created!.id })
      .where(eq(loyaltyPrograms.id, program.id));
    await tx.insert(auditLogs).values({
      organizationId: orgId,
      actorType: operator.actorType,
      actorId: operator.orgUserId,
      action: 'program.rule_changed',
      entityType: 'program_rule_version',
      entityId: created!.id,
      before: prev
        ? { version: prev.version, earnRule: prev.earnRule, goal: prev.goal, limits: prev.limits }
        : null,
      after: { version: created!.version, earnRule: rule.earnRule, goal: rule.goal, limits: rule.limits },
    });
    // Cambia lo que muestran los pases de todo el programa (p. ej. la meta): lo consumirá la semana 7.
    await tx.insert(eventOutbox).values({
      organizationId: orgId,
      type: 'program.updated',
      aggregateId: program.id,
      payload: { version: next },
    });
    return { id: created!.id, version: created!.version };
  });
}

export interface RewardInput {
  kind: RewardKind;
  name: string;
  description?: string | null;
  cost?: number | null;
  validityDays?: number | null;
  active?: boolean;
  sortOrder?: number;
}

function validateReward(mode: 'stamps' | 'points', r: RewardInput) {
  const bad = (message: string) => new LoyaltyError('invalid_rule', { field: 'reward' }, message);
  if (!r.name?.trim() || r.name.trim().length > 80)
    throw bad('El nombre del premio es obligatorio (máx. 80 caracteres)');
  if (r.kind === 'goal' && mode !== 'stamps')
    throw bad('El premio de meta solo existe en programas de sellos');
  if (r.kind === 'catalog' && mode !== 'points')
    throw bad('El catálogo de premios solo existe en programas de puntos');
  if (r.kind === 'catalog' && !(Number.isInteger(r.cost) && r.cost! > 0))
    throw bad('Un premio de catálogo necesita un costo en puntos');
  if (r.kind !== 'catalog' && r.cost != null) throw bad('Solo los premios de catálogo tienen costo');
  if (
    r.validityDays != null &&
    !(Number.isInteger(r.validityDays) && r.validityDays > 0 && r.validityDays <= 730)
  )
    throw bad('La vigencia debe estar entre 1 y 730 días');
}

async function assertSingleActiveGoal(tx: Tx, orgId: string, programId: string, exceptId?: string) {
  const [other] = await tx
    .select({ id: rewards.id })
    .from(rewards)
    .where(
      and(
        eq(rewards.organizationId, orgId),
        eq(rewards.programId, programId),
        eq(rewards.kind, 'goal'),
        eq(rewards.active, true),
        exceptId ? ne(rewards.id, exceptId) : undefined,
      ),
    );
  if (other)
    throw new LoyaltyError(
      'invalid_rule',
      { field: 'reward' },
      'Ya hay un premio de meta activo; desactívalo antes de crear otro',
    );
}

export async function createReward(db: Db, orgId: string, operator: Operator, input: RewardInput) {
  return withTenantTx(db, orgId, async (tx) => {
    const program = await activeProgram(tx, orgId, true);
    validateReward(program.mode, input);
    if (input.kind === 'goal' && input.active !== false) await assertSingleActiveGoal(tx, orgId, program.id);
    const [r] = await tx
      .insert(rewards)
      .values({
        organizationId: orgId,
        programId: program.id,
        kind: input.kind,
        name: input.name.trim(),
        description: input.description?.trim() || null,
        cost: input.kind === 'catalog' ? input.cost! : null,
        validityDays: input.validityDays ?? null,
        active: input.active ?? true,
        sortOrder: input.sortOrder ?? 0,
      })
      .returning();
    await tx.insert(auditLogs).values({
      organizationId: orgId,
      actorType: operator.actorType,
      actorId: operator.orgUserId,
      action: 'reward.created',
      entityType: 'reward',
      entityId: r!.id,
      after: { kind: r!.kind, name: r!.name, cost: r!.cost },
    });
    return r!;
  });
}

export async function updateReward(
  db: Db,
  orgId: string,
  operator: Operator,
  rewardId: string,
  patch: Partial<Omit<RewardInput, 'kind'>>,
) {
  return withTenantTx(db, orgId, async (tx) => {
    const program = await activeProgram(tx, orgId, true);
    const [current] = await tx
      .select()
      .from(rewards)
      .where(
        and(eq(rewards.id, rewardId), eq(rewards.organizationId, orgId), eq(rewards.programId, program.id)),
      )
      .for('update');
    if (!current) throw notFound();
    const merged: RewardInput = {
      kind: current.kind,
      name: patch.name ?? current.name,
      description: patch.description !== undefined ? patch.description : current.description,
      cost: patch.cost !== undefined ? patch.cost : current.cost,
      validityDays: patch.validityDays !== undefined ? patch.validityDays : current.validityDays,
      active: patch.active ?? current.active,
      sortOrder: patch.sortOrder ?? current.sortOrder,
    };
    validateReward(program.mode, merged);
    if (merged.kind === 'goal' && merged.active)
      await assertSingleActiveGoal(tx, orgId, program.id, current.id);
    const [r] = await tx
      .update(rewards)
      .set({
        name: merged.name.trim(),
        description: merged.description?.trim() || null,
        cost: merged.kind === 'catalog' ? merged.cost! : null,
        validityDays: merged.validityDays ?? null,
        active: merged.active,
        sortOrder: merged.sortOrder,
      })
      .where(eq(rewards.id, current.id))
      .returning();
    await tx.insert(auditLogs).values({
      organizationId: orgId,
      actorType: operator.actorType,
      actorId: operator.orgUserId,
      action: 'reward.updated',
      entityType: 'reward',
      entityId: current.id,
      before: {
        name: current.name,
        cost: current.cost,
        active: current.active,
        validityDays: current.validityDays,
      },
      after: { name: r!.name, cost: r!.cost, active: r!.active, validityDays: r!.validityDays },
    });
    return r!;
  });
}
