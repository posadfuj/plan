/** Panel del dueño: equipo de caja (PIN) y dispositivos autorizados. */
import { can } from '@aiment/core';
import {
  createPairing,
  createStaffMember,
  deactivateStaffMember,
  listDevices,
  listTeam,
  revokeDevice,
  setPin,
  type Manager,
} from '@aiment/staff';
import { Hono, type Context } from 'hono';
import { isUuid, requireOrgMember, requirePermission, requireUser } from '../auth/middleware';
import type { AppEnv } from '../context';
import { HttpError, notFound } from '../errors';
import { jsonBody } from '../request';

function manager(c: Context<AppEnv>): Manager {
  const actor = c.var.actor;
  if (actor.kind !== 'member') throw new HttpError(403, 'forbidden', 'Acción no permitida');
  return { orgUserId: actor.orgUserId, actorType: 'owner' };
}

function uuidParam(c: Context<AppEnv>, name: string): string {
  const v = c.req.param(name);
  if (!isUuid(v)) throw notFound();
  return v;
}

export const teamRoutes = new Hono<AppEnv>()
  .use(requireUser, requireOrgMember)

  .get('/team', requirePermission('team.read'), async (c) => {
    const me = manager(c).orgUserId;
    const team = await listTeam(c.var.deps.db, c.var.orgId);
    return c.json({ team: team.map((p) => ({ ...p, isMe: p.id === me })) });
  })

  .post('/team', requirePermission('team.manage_staff'), async (c) => {
    const b = await jsonBody(c);
    const person = await createStaffMember(c.var.deps.db, c.var.orgId, manager(c), {
      name: b.name,
      pin: b.pin,
    });
    return c.json({ person }, 201);
  })

  // Cada quien cambia su PIN; el de un trabajador de caja lo cambia también quien gestiona el equipo.
  .post('/team/:orgUserId/pin', requirePermission('org.read'), async (c) => {
    const target = uuidParam(c, 'orgUserId');
    const b = await jsonBody(c);
    const actor = c.var.actor;
    await setPin(
      c.var.deps.db,
      c.var.orgId,
      { ...manager(c), canManageStaff: can(actor, 'team.manage_staff', c.var.orgId) },
      target,
      b.pin,
    );
    return c.json({ updated: true });
  })

  .post('/team/:orgUserId/deactivate', requirePermission('team.manage_staff'), async (c) => {
    await deactivateStaffMember(c.var.deps.db, c.var.orgId, manager(c), uuidParam(c, 'orgUserId'));
    return c.json({ deactivated: true });
  })

  .get('/devices', requirePermission('devices.manage'), async (c) =>
    c.json({ devices: await listDevices(c.var.deps.db, c.var.orgId) }),
  )

  .post('/devices/pairings', requirePermission('devices.manage'), async (c) => {
    const b = await jsonBody(c);
    const out = await createPairing(
      c.var.deps.db,
      c.var.orgId,
      manager(c),
      { name: b.name, branchId: b.branchId },
      c.var.deps.publicBaseUrl,
    );
    c.header('Cache-Control', 'no-store');
    return c.json(out, 201);
  })

  .post('/devices/:deviceId/revoke', requirePermission('devices.manage'), async (c) => {
    await revokeDevice(c.var.deps.db, c.var.orgId, manager(c), uuidParam(c, 'deviceId'));
    return c.json({ revoked: true });
  });
