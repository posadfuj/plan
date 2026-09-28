/**
 * Lo que ve la caja de un cliente: nombre, saldo, premios disponibles y sus últimos movimientos,
 * con lo que la persona del turno puede anular. Las operaciones (sumar, canjear, anular) las hace
 * @aiment/ledger, el mismo servicio que usa el panel.
 */
import { maskPhone, normalizePhone, STAFF_VOID_WINDOW_MINUTES } from '@aiment/core';
import { schema, withTenantTx, type Db, type Tx } from '@aiment/db';
import { isToken } from '@aiment/enrollment';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { StaffError, notFound } from './errors';

const {
  memberships,
  customers,
  loyaltyPrograms,
  programRuleVersions,
  rewards,
  earnedRewards,
  ledgerEntries,
  redemptions,
  organizationUsers,
} = schema;

const VOID_WINDOW_MS = STAFF_VOID_WINDOW_MINUTES * 60_000;
const SHORT_CODE_RE = /^[23456789A-HJ-NP-Z]{6}$/;

export interface CashierOperator {
  orgUserId: string;
  canVoidAny: boolean;
}

/** Busca la membresía por el QR del cliente (/s/{token}). */
export async function membershipIdByScanToken(db: Db, orgId: string, scanToken: string): Promise<string> {
  if (!isToken(scanToken)) throw notFound();
  const [m] = await withTenantTx(db, orgId, (tx) =>
    tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.memberScanToken, scanToken), eq(memberships.organizationId, orgId))),
  );
  if (!m) throw new StaffError(404, 'not_found', 'Este código no es una tarjeta de este negocio');
  return m.id;
}

/** Búsqueda por celular (exacto) o por el código corto de la tarjeta. */
export async function searchMemberships(db: Db, orgId: string, q: string) {
  const text = q.trim();
  const code = text.toUpperCase().replace(/\s/g, '');
  const phone = normalizePhone(text);
  if (!phone && !SHORT_CODE_RE.test(code))
    throw new StaffError(
      422,
      'invalid_search',
      'Escribe el celular (9 dígitos) o el código de 6 letras de la tarjeta',
    );
  const rows = await withTenantTx(db, orgId, (tx) =>
    tx
      .select({
        membershipId: memberships.id,
        name: customers.fullName,
        phone: customers.phoneE164,
        shortCode: memberships.shortCode,
        status: memberships.status,
      })
      .from(memberships)
      .innerJoin(customers, eq(customers.id, memberships.customerId))
      .where(
        and(
          eq(memberships.organizationId, orgId),
          eq(customers.status, 'active'),
          phone ? eq(customers.phoneE164, phone) : eq(memberships.shortCode, code),
        ),
      )
      .limit(5),
  );
  return rows.map(({ phone: p, ...r }) => ({ ...r, phone: p ? maskPhone(p) : null }));
}

async function recentActivity(tx: Tx, orgId: string, membershipId: string, op: CashierOperator) {
  const entries = await tx
    .select({
      id: ledgerEntries.id,
      kind: ledgerEntries.kind,
      delta: ledgerEntries.delta,
      actorId: ledgerEntries.actorId,
      actorName: organizationUsers.displayName,
      createdAt: ledgerEntries.createdAt,
      reversed: sql<boolean>`exists (select 1 from app.ledger_entries r where r.reverses_entry_id = ${ledgerEntries.id})`,
    })
    .from(ledgerEntries)
    .leftJoin(organizationUsers, eq(organizationUsers.id, ledgerEntries.actorId))
    .where(
      and(
        eq(ledgerEntries.organizationId, orgId),
        eq(ledgerEntries.membershipId, membershipId),
        inArray(ledgerEntries.kind, ['earn', 'bonus', 'redeem', 'adjust', 'reversal']),
      ),
    )
    .orderBy(desc(ledgerEntries.createdAt))
    .limit(8);
  // Canjes de premios ganados (sellos): no mueven saldo, así que no están en el ledger.
  const rewardRedemptions = await tx
    .select({
      id: redemptions.id,
      reward: rewards.name,
      actorId: redemptions.organizationUserId,
      actorName: organizationUsers.displayName,
      status: redemptions.status,
      createdAt: redemptions.createdAt,
    })
    .from(redemptions)
    .innerJoin(rewards, eq(rewards.id, redemptions.rewardId))
    .leftJoin(organizationUsers, eq(organizationUsers.id, redemptions.organizationUserId))
    .where(
      and(
        eq(redemptions.organizationId, orgId),
        eq(redemptions.membershipId, membershipId),
        isNull(redemptions.ledgerEntryId),
      ),
    )
    .orderBy(desc(redemptions.createdAt))
    .limit(5);

  const now = Date.now();
  const recent = (at: Date) => now - at.getTime() <= VOID_WINDOW_MS;
  // El trabajador solo anula su último movimiento propio (misma regla que el motor).
  const latestOwn = entries.find(
    (e) =>
      e.actorId === op.orgUserId && ['earn', 'bonus', 'redeem', 'adjust'].includes(e.kind) && !e.reversed,
  );
  const items = [
    ...entries.map((e) => ({
      type: 'entry' as const,
      id: e.id,
      kind: e.kind,
      delta: e.delta,
      label: null as string | null,
      by: e.actorName,
      at: e.createdAt,
      voided: e.reversed,
      canVoid:
        ['earn', 'redeem', 'adjust'].includes(e.kind) &&
        !e.reversed &&
        (op.canVoidAny || (e.id === latestOwn?.id && recent(e.createdAt))),
    })),
    ...rewardRedemptions.map((r) => ({
      type: 'redemption' as const,
      id: r.id,
      kind: 'reward_redeemed',
      delta: 0,
      label: r.reward,
      by: r.actorName,
      at: r.createdAt,
      voided: r.status === 'voided',
      canVoid:
        r.status === 'completed' && (op.canVoidAny || (r.actorId === op.orgUserId && recent(r.createdAt))),
    })),
  ];
  return items.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 8);
}

/** Ficha del cliente para la caja. */
export async function cashierView(db: Db, orgId: string, membershipId: string, op: CashierOperator) {
  return withTenantTx(db, orgId, async (tx) => {
    const [row] = await tx
      .select({
        id: memberships.id,
        status: memberships.status,
        balance: memberships.balance,
        shortCode: memberships.shortCode,
        firstValidatedAt: memberships.firstValidatedAt,
        name: customers.fullName,
        phone: customers.phoneE164,
        programId: loyaltyPrograms.id,
        mode: loyaltyPrograms.mode,
        unitLabel: loyaltyPrograms.unitLabel,
        goal: programRuleVersions.goal,
        limits: programRuleVersions.limits,
      })
      .from(memberships)
      .innerJoin(customers, eq(customers.id, memberships.customerId))
      .innerJoin(loyaltyPrograms, eq(loyaltyPrograms.id, memberships.programId))
      .innerJoin(programRuleVersions, eq(programRuleVersions.id, loyaltyPrograms.currentVersionId))
      .where(
        and(
          eq(memberships.id, membershipId),
          eq(memberships.organizationId, orgId),
          eq(customers.status, 'active'),
        ),
      );
    if (!row) throw notFound();
    const available = await tx
      .select({ id: earnedRewards.id, name: rewards.name, expiresAt: earnedRewards.expiresAt })
      .from(earnedRewards)
      .innerJoin(rewards, eq(rewards.id, earnedRewards.rewardId))
      .where(
        and(
          eq(earnedRewards.organizationId, orgId),
          eq(earnedRewards.membershipId, membershipId),
          eq(earnedRewards.status, 'available'),
        ),
      )
      .orderBy(asc(earnedRewards.createdAt));
    const catalog =
      row.mode === 'points'
        ? await tx
            .select({ id: rewards.id, name: rewards.name, cost: rewards.cost })
            .from(rewards)
            .where(
              and(
                eq(rewards.organizationId, orgId),
                eq(rewards.programId, row.programId),
                eq(rewards.kind, 'catalog'),
                eq(rewards.active, true),
              ),
            )
            .orderBy(asc(rewards.cost), asc(rewards.sortOrder))
        : [];
    const limits = (row.limits ?? {}) as { max_amount_per_tx?: number };
    return {
      membershipId: row.id,
      status: row.status,
      customer: { name: row.name, phone: row.phone ? maskPhone(row.phone) : null },
      shortCode: row.shortCode,
      firstVisit: row.firstValidatedAt === null,
      program: {
        mode: row.mode,
        unitLabel: row.unitLabel,
        goal: row.goal,
        maxAmountPerTx: limits.max_amount_per_tx ?? null,
      },
      balance: row.balance,
      availableRewards: available,
      catalog: catalog.map((r) => ({ ...r, affordable: row.balance >= (r.cost ?? Infinity) })),
      activity: await recentActivity(tx, orgId, membershipId, op),
    };
  });
}
