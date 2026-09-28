/**
 * Negocios de prueba creados al vuelo para los tests del ledger (no dependen del seed).
 * Se crean con una transacción de sistema usando el mismo rol de la API.
 */
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { schema, withSystemTx, type Db } from '@aiment/db';
import { eq } from 'drizzle-orm';
import type { Operator } from './types';

export interface TestOrg {
  orgId: string;
  programId: string;
  ruleVersionId: string;
  goalRewardId: string | null;
  giftRewardId: string;
  catalog: { id: string; cost: number }[];
  owner: Operator;
  staff: Operator;
  staff2: Operator;
  newMembership: () => Promise<string>;
}

const token = () => randomBytes(16).toString('base64url');

export async function createTestOrg(
  db: Db,
  opts: {
    mode: 'stamps' | 'points';
    goal?: number | null;
    limits?: Record<string, unknown>;
    welcomeBonus?: Record<string, unknown>;
    expirationMonths?: number | null;
  },
): Promise<TestOrg> {
  const orgId = randomUUID();
  const programId = randomUUID();
  const ruleVersionId = randomUUID();
  const ownerId = randomUUID();
  const staffId = randomUUID();
  const staff2Id = randomUUID();
  const suffix = orgId.slice(0, 8);
  const catalog: { id: string; cost: number }[] = [];
  let goalRewardId: string | null = null;
  let giftRewardId = '';

  await withSystemTx(db, async (tx) => {
    await tx.insert(schema.plans).values({ code: 'start', name: 'Start' }).onConflictDoNothing();
    await tx.insert(schema.organizations).values({
      id: orgId,
      slug: `test-${suffix}`,
      name: `Negocio de prueba ${suffix}`,
      status: 'live',
      planCode: 'start',
    });
    await tx.insert(schema.organizationUsers).values([
      { id: ownerId, organizationId: orgId, displayName: 'Dueño test', role: 'staff' },
      { id: staffId, organizationId: orgId, displayName: 'Caja 1', role: 'staff' },
      { id: staff2Id, organizationId: orgId, displayName: 'Caja 2', role: 'staff' },
    ]);
    await tx.insert(schema.loyaltyPrograms).values({
      id: programId,
      organizationId: orgId,
      name: 'Club test',
      mode: opts.mode,
      unitLabel: opts.mode === 'stamps' ? 'sellos' : 'puntos',
      status: 'active',
    });
    await tx.insert(schema.programRuleVersions).values({
      id: ruleVersionId,
      organizationId: orgId,
      programId,
      version: 1,
      earnRule:
        opts.mode === 'stamps' ? { type: 'per_visit', units: 1 } : { type: 'per_amount', amount_per_unit: 1 },
      goal: opts.mode === 'stamps' ? (opts.goal ?? 10) : null,
      welcomeBonus: opts.welcomeBonus ?? { type: 'none' },
      limits: opts.limits ?? {},
      expirationMonths: opts.expirationMonths ?? null,
    });
    await tx
      .update(schema.loyaltyPrograms)
      .set({ currentVersionId: ruleVersionId })
      .where(eq(schema.loyaltyPrograms.id, programId));
    if (opts.mode === 'stamps') {
      const [g] = await tx
        .insert(schema.rewards)
        .values({ organizationId: orgId, programId, kind: 'goal', name: 'Premio de meta', validityDays: 30 })
        .returning({ id: schema.rewards.id });
      goalRewardId = g!.id;
    } else {
      for (const [name, cost] of [
        ['Café', 50],
        ['Postre', 120],
      ] as const) {
        const [r] = await tx
          .insert(schema.rewards)
          .values({ organizationId: orgId, programId, kind: 'catalog', name, cost })
          .returning({ id: schema.rewards.id });
        catalog.push({ id: r!.id, cost });
      }
    }
    const [gift] = await tx
      .insert(schema.rewards)
      .values({ organizationId: orgId, programId, kind: 'gift', name: 'Regalo de bienvenida' })
      .returning({ id: schema.rewards.id });
    giftRewardId = gift!.id;
  });

  const op = (id: string, owner: boolean): Operator => ({
    actorType: owner ? 'owner' : 'staff',
    orgUserId: id,
    canVoidAny: owner,
    canOverrideLimits: owner,
  });

  let n = 0;
  return {
    orgId,
    programId,
    ruleVersionId,
    goalRewardId,
    giftRewardId,
    catalog,
    owner: op(ownerId, true),
    staff: op(staffId, false),
    staff2: op(staff2Id, false),
    async newMembership() {
      const customerId = randomUUID();
      const membershipId = randomUUID();
      n++;
      await withSystemTx(db, async (tx) => {
        await tx.insert(schema.customers).values({
          id: customerId,
          organizationId: orgId,
          fullName: `Cliente ${n}`,
          phoneE164: `+519${randomInt(10_000_000, 99_999_999)}`,
        });
        await tx.insert(schema.memberships).values({
          id: membershipId,
          organizationId: orgId,
          programId,
          customerId,
          memberScanToken: token(),
          webCardToken: token(),
          shortCode: `T${suffix.slice(0, 3)}${n}`.toUpperCase(),
        });
      });
      return membershipId;
    },
  };
}
