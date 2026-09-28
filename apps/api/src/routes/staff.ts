/**
 * Caja (semana 4): dispositivo autorizado + turno con PIN. El negocio sale del dispositivo, nunca
 * de la URL: un dispositivo solo ve y opera clientes de su propio negocio.
 * Las operaciones usan el mismo servicio de @aiment/ledger que el panel.
 */
import { can, LoyaltyError, type LoyaltyErrorCode } from '@aiment/core';
import { issueInStoreRecovery } from '@aiment/enrollment';
import { earn, redeem, voidEntry, voidRedemption, type OperationResult, type Operator } from '@aiment/ledger';
import {
  cashierView,
  claimPairing,
  endShift,
  listRegisterPeople,
  membershipIdByScanToken,
  resolveShift,
  searchMemberships,
  startShift,
  verifyOverridePin,
} from '@aiment/staff';
import { Hono, type Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { z } from 'zod';
import { isUuid } from '../auth/middleware';
import {
  clearShiftCookie,
  requireDevice,
  requireRegisterPermission,
  requireShift,
  setDeviceCookie,
  setShiftCookie,
  SHIFT_COOKIE,
} from '../auth/register';
import type { AppEnv } from '../context';
import { HttpError, notFound } from '../errors';
import { jsonBody, limit, privateHeaders, TEN_MIN } from '../request';

const amount = z.union([z.number(), z.string().trim().max(20)]).nullish();
const earnBody = z
  .object({
    amount,
    /** Excepción de límites: motivo y, si quien atiende no es dueño/admin, el PIN del dueño o de un admin. */
    override: z
      .object({ reason: z.string().trim().max(300), pin: z.string().max(6).optional() })
      .strict()
      .nullish(),
  })
  .strict();
const redeemBody = z
  .object({ earnedRewardId: z.string().uuid().nullish(), rewardId: z.string().uuid().nullish() })
  .strict();
const voidBody = z.object({ reason: z.string().max(300) }).strict();

/** Límites que el dueño (o un admin) puede autorizar a pasar con su PIN. */
const OVERRIDABLE_LIMITS: readonly LoyaltyErrorCode[] = [
  'cooldown_active',
  'max_units_per_tx',
  'max_amount_per_tx',
  'staff_daily_units',
];

function operatorFrom(c: Context<AppEnv>): Operator {
  const actor = c.var.actor;
  if (actor.kind !== 'register') throw new HttpError(403, 'forbidden', 'Acción no permitida');
  return {
    actorType: actor.role === 'staff' ? 'staff' : 'owner',
    orgUserId: actor.orgUserId,
    deviceId: actor.deviceId,
    branchId: actor.branchId,
    canVoidAny: can(actor, 'ledger.void.any', actor.orgId),
    canOverrideLimits: can(actor, 'limits.override', actor.orgId),
  };
}

function uuidParam(c: Context<AppEnv>, name: string): string {
  const v = c.req.param(name);
  if (!isUuid(v)) throw notFound();
  return v;
}

async function body<T extends z.ZodTypeAny>(c: Context<AppEnv>, schemaDef: T): Promise<z.infer<T>> {
  return schemaDef.parse(await c.req.json().catch(() => ({})));
}

function view(c: Context<AppEnv>, membershipId: string) {
  const op = operatorFrom(c);
  return cashierView(c.var.deps.db, c.var.orgId, membershipId, op);
}

/** Resultado de la operación + ficha actualizada (la caja la muestra sin otra consulta). */
async function respond(c: Context<AppEnv>, result: OperationResult) {
  privateHeaders(c);
  if (result.replayed) c.header('Idempotent-Replayed', 'true');
  return c.json({ ...result, view: await view(c, result.membership.id) }, result.replayed ? 200 : 201);
}

const idempotencyKey = (c: Context<AppEnv>) => c.req.header('idempotency-key') ?? '';

export const staffRoutes = new Hono<AppEnv>()
  // --- Dispositivo ------------------------------------------------------------
  .post('/device/pair', async (c) => {
    limit(c, 'devicePair', TEN_MIN);
    const b = await jsonBody(c);
    const { secret, device } = await claimPairing(c.var.deps.db, String(b.code ?? ''));
    setDeviceCookie(c, secret);
    clearShiftCookie(c);
    privateHeaders(c);
    return c.json({ device: { name: device.name } }, 201);
  })

  .get('/device', requireDevice, async (c) => {
    const { db } = c.var.deps;
    const device = c.var.device;
    const shift = await resolveShift(db, device, getCookie(c, SHIFT_COOKIE));
    privateHeaders(c);
    return c.json({
      organization: { name: device.orgName },
      device: { name: device.deviceName, branch: device.branchName },
      people: await listRegisterPeople(db, device),
      shift: shift && { name: shift.name, role: shift.role, expiresAt: shift.expiresAt },
    });
  })

  // --- Turno ------------------------------------------------------------------
  .post('/shift', requireDevice, async (c) => {
    limit(c, 'staffLogin', TEN_MIN, c.var.device.deviceId);
    const b = await jsonBody(c);
    const out = await startShift(c.var.deps.db, c.var.device, { personId: b.personId, pin: b.pin });
    setShiftCookie(c, out.token);
    privateHeaders(c);
    return c.json({ shift: { name: out.person.name, role: out.person.role, expiresAt: out.expiresAt } }, 201);
  })

  .delete('/shift', requireDevice, requireShift, async (c) => {
    await endShift(c.var.deps.db, c.var.device, c.var.shift);
    clearShiftCookie(c);
    return c.json({ closed: true });
  })

  // --- Clientes ---------------------------------------------------------------
  .get(
    '/scan/:scanToken',
    requireDevice,
    requireShift,
    requireRegisterPermission('membership.read'),
    async (c) => {
      const id = await membershipIdByScanToken(c.var.deps.db, c.var.orgId, c.req.param('scanToken'));
      privateHeaders(c);
      return c.json(await view(c, id));
    },
  )

  .get(
    '/memberships',
    requireDevice,
    requireShift,
    requireRegisterPermission('customers.search'),
    async (c) => {
      limit(c, 'staffSearch', 60_000, c.var.device.deviceId);
      privateHeaders(c);
      return c.json({ results: await searchMemberships(c.var.deps.db, c.var.orgId, c.req.query('q') ?? '') });
    },
  )

  .get(
    '/memberships/:membershipId',
    requireDevice,
    requireShift,
    requireRegisterPermission('membership.read'),
    async (c) => {
      privateHeaders(c);
      return c.json(await view(c, uuidParam(c, 'membershipId')));
    },
  )

  // --- Operaciones ------------------------------------------------------------
  .post(
    '/memberships/:membershipId/earn',
    requireDevice,
    requireShift,
    requireRegisterPermission('ledger.earn'),
    async (c) => {
      const membershipId = uuidParam(c, 'membershipId');
      const b = await body(c, earnBody);
      const operator = operatorFrom(c);
      if (b.override && !operator.canOverrideLimits) {
        limit(c, 'staffOverride', 15 * 60_000, c.var.device.deviceId);
        const approver = await verifyOverridePin(c.var.deps.db, c.var.orgId, b.override.pin);
        if (!approver)
          throw new HttpError(403, 'invalid_override_pin', 'PIN del dueño o del administrador incorrecto');
        operator.canOverrideLimits = true;
        operator.overrideApprovedBy = approver.orgUserId;
      }
      try {
        return await respond(
          c,
          await earn(c.var.deps.db, c.var.orgId, {
            membershipId,
            amount: b.amount ?? null,
            overrideReason: b.override?.reason ?? null,
            operator,
            idempotencyKey: idempotencyKey(c),
          }),
        );
      } catch (err) {
        // En caja, un límite siempre se puede pasar con el PIN del dueño: la pantalla ofrece esa opción.
        if (err instanceof LoyaltyError && OVERRIDABLE_LIMITS.includes(err.code))
          throw new LoyaltyError(err.code, { ...err.details, overridable: true }, err.message);
        throw err;
      }
    },
  )

  .post(
    '/memberships/:membershipId/redeem',
    requireDevice,
    requireShift,
    requireRegisterPermission('ledger.redeem'),
    async (c) => {
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
    },
  )

  .post(
    '/ledger/:entryId/void',
    requireDevice,
    requireShift,
    requireRegisterPermission('ledger.void.own_recent'),
    async (c) => {
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
    },
  )

  .post(
    '/redemptions/:redemptionId/void',
    requireDevice,
    requireShift,
    requireRegisterPermission('ledger.void.own_recent'),
    async (c) => {
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
    },
  )

  .post(
    '/memberships/:membershipId/recovery',
    requireDevice,
    requireShift,
    requireRegisterPermission('membership.recovery'),
    async (c) => {
      const membershipId = uuidParam(c, 'membershipId');
      const op = operatorFrom(c);
      const out = await issueInStoreRecovery(
        { db: c.var.deps.db, mailer: c.var.deps.mailer, publicBaseUrl: c.var.deps.publicBaseUrl },
        c.var.orgId,
        membershipId,
        { orgUserId: op.orgUserId, actorType: op.actorType, deviceId: op.deviceId },
      );
      privateHeaders(c);
      return c.json(out, 201);
    },
  );
