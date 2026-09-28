/**
 * Operaciones de fidelización para dueño/admin (semana 2).
 * La caja (dispositivo + PIN, semana 4) reutilizará exactamente el mismo servicio de @aiment/ledger.
 */
import { can } from '@aiment/core';
import { schema, withTenantTx } from '@aiment/db';
import {
  adjust,
  createReward,
  createRuleVersion,
  earn,
  getMembershipState,
  getProgram,
  redeem,
  updateReward,
  voidEntry,
  voidRedemption,
  type OperationResult,
  type Operator,
} from '@aiment/ledger';
import { and, asc, desc, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { isUuid, requireOrgMember, requirePermission, requireUser } from '../auth/middleware';
import type { AppEnv } from '../context';
import { HttpError, notFound } from '../errors';

const amount = z.union([z.number(), z.string().trim().max(20)]).nullish();
const earnBody = z.object({ amount, overrideReason: z.string().trim().max(300).nullish() }).strict();
const redeemBody = z
  .object({ earnedRewardId: z.string().uuid().nullish(), rewardId: z.string().uuid().nullish() })
  .strict();
const adjustBody = z.object({ delta: z.number().int(), reason: z.string().max(300) }).strict();
const voidBody = z.object({ reason: z.string().max(300) }).strict();
const rewardBody = z
  .object({
    kind: z.enum(['goal', 'catalog', 'gift']),
    name: z.string().max(80),
    description: z.string().max(300).nullish(),
    cost: z.number().int().nullish(),
    validityDays: z.number().int().nullish(),
    active: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
  })
  .strict();
const rewardPatch = rewardBody.omit({ kind: true }).partial().strict();

/** Operador para el servicio de ledger: dueño/admin autenticados con Supabase Auth. */
function operatorFrom(c: Context<AppEnv>): Operator {
  const actor = c.var.actor;
  if (actor.kind !== 'member') throw new HttpError(403, 'forbidden', 'Acción no permitida');
  return {
    actorType: actor.role === 'staff' ? 'staff' : 'owner',
    orgUserId: actor.orgUserId,
    canVoidAny: can(actor, 'ledger.void.any', actor.orgId),
    canOverrideLimits: can(actor, 'limits.override', actor.orgId),
  };
}

function idempotencyKey(c: Context<AppEnv>): string {
  return c.req.header('idempotency-key') ?? '';
}

function uuidParam(c: Context<AppEnv>, name: string): string {
  const v = c.req.param(name);
  if (!isUuid(v)) throw notFound();
  return v;
}

async function body<T extends z.ZodTypeAny>(c: Context<AppEnv>, schemaDef: T): Promise<z.infer<T>> {
  return schemaDef.parse(await c.req.json().catch(() => ({})));
}

/** 201 si la operación es nueva; 200 + cabecera Idempotent-Replayed si es un reintento. */
function respond(c: Context<AppEnv>, result: OperationResult) {
  if (result.replayed) c.header('Idempotent-Replayed', 'true');
  return c.json(result, result.replayed ? 200 : 201);
}

export const loyaltyRoutes = new Hono<AppEnv>()
  .use(requireUser, requireOrgMember)

  // --- Programa, reglas y premios -------------------------------------------
  .get('/program', requirePermission('org.read'), async (c) =>
    c.json(await getProgram(c.var.deps.db, c.var.orgId)),
  )

  .post('/program/rules', requirePermission('program.manage'), async (c) => {
    const input = await c.req.json().catch(() => ({}));
    return c.json(await createRuleVersion(c.var.deps.db, c.var.orgId, operatorFrom(c), input), 201);
  })

  .post('/rewards', requirePermission('rewards.manage'), async (c) => {
    const input = await body(c, rewardBody);
    return c.json(await createReward(c.var.deps.db, c.var.orgId, operatorFrom(c), input), 201);
  })

  .patch('/rewards/:rewardId', requirePermission('rewards.manage'), async (c) => {
    const rewardId = uuidParam(c, 'rewardId');
    const patch = await body(c, rewardPatch);
    return c.json(await updateReward(c.var.deps.db, c.var.orgId, operatorFrom(c), rewardId, patch));
  })

  // --- Membresías y movimientos ---------------------------------------------
  .get('/memberships/:membershipId', requirePermission('membership.read'), async (c) => {
    const membershipId = uuidParam(c, 'membershipId');
    const orgId = c.var.orgId;
    const data = await withTenantTx(c.var.deps.db, orgId, async (tx) => {
      const state = await getMembershipState(tx, orgId, membershipId);
      const movements = await tx
        .select({
          id: schema.ledgerEntries.id,
          kind: schema.ledgerEntries.kind,
          delta: schema.ledgerEntries.delta,
          balanceAfter: schema.ledgerEntries.balanceAfter,
          reason: schema.ledgerEntries.reason,
          reversesEntryId: schema.ledgerEntries.reversesEntryId,
          createdAt: schema.ledgerEntries.createdAt,
        })
        .from(schema.ledgerEntries)
        .where(
          and(
            eq(schema.ledgerEntries.membershipId, membershipId),
            eq(schema.ledgerEntries.organizationId, orgId),
          ),
        )
        .orderBy(desc(schema.ledgerEntries.createdAt))
        .limit(20);
      const [m] = await tx
        .select({ programId: schema.memberships.programId })
        .from(schema.memberships)
        .where(eq(schema.memberships.id, membershipId));
      const catalog = await tx
        .select({ id: schema.rewards.id, name: schema.rewards.name, cost: schema.rewards.cost })
        .from(schema.rewards)
        .where(
          and(
            eq(schema.rewards.organizationId, orgId),
            eq(schema.rewards.programId, m!.programId),
            eq(schema.rewards.kind, 'catalog'),
            eq(schema.rewards.active, true),
          ),
        )
        .orderBy(asc(schema.rewards.sortOrder));
      return {
        ...state,
        catalog: catalog.map((r) => ({ ...r, affordable: state.balance >= (r.cost ?? Infinity) })),
        movements,
      };
    });
    return c.json(data);
  })

  .post('/memberships/:membershipId/earn', requirePermission('ledger.earn'), async (c) => {
    const membershipId = uuidParam(c, 'membershipId');
    const b = await body(c, earnBody);
    return respond(
      c,
      await earn(c.var.deps.db, c.var.orgId, {
        membershipId,
        amount: b.amount ?? null,
        overrideReason: b.overrideReason ?? null,
        operator: operatorFrom(c),
        idempotencyKey: idempotencyKey(c),
      }),
    );
  })

  .post('/memberships/:membershipId/redeem', requirePermission('ledger.redeem'), async (c) => {
    const membershipId = uuidParam(c, 'membershipId');
    const b = await body(c, redeemBody);
    return respond(
      c,
      await redeem(c.var.deps.db, c.var.orgId, {
        membershipId,
        earnedRewardId: b.earnedRewardId ?? null,
        rewardId: b.rewardId ?? null,
        operator: operatorFrom(c),
        idempotencyKey: idempotencyKey(c),
      }),
    );
  })

  .post('/memberships/:membershipId/adjust', requirePermission('ledger.adjust'), async (c) => {
    const membershipId = uuidParam(c, 'membershipId');
    const b = await body(c, adjustBody);
    return respond(
      c,
      await adjust(c.var.deps.db, c.var.orgId, {
        membershipId,
        delta: b.delta,
        reason: b.reason,
        operator: operatorFrom(c),
        idempotencyKey: idempotencyKey(c),
      }),
    );
  })

  .post('/ledger/:entryId/void', requirePermission('ledger.void.own_recent'), async (c) => {
    const entryId = uuidParam(c, 'entryId');
    const b = await body(c, voidBody);
    return respond(
      c,
      await voidEntry(c.var.deps.db, c.var.orgId, {
        entryId,
        reason: b.reason,
        operator: operatorFrom(c),
        idempotencyKey: idempotencyKey(c),
      }),
    );
  })

  .post('/redemptions/:redemptionId/void', requirePermission('ledger.void.own_recent'), async (c) => {
    const redemptionId = uuidParam(c, 'redemptionId');
    const b = await body(c, voidBody);
    return respond(
      c,
      await voidRedemption(c.var.deps.db, c.var.orgId, {
        redemptionId,
        reason: b.reason,
        operator: operatorFrom(c),
        idempotencyKey: idempotencyKey(c),
      }),
    );
  });
