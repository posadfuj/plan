/**
 * Panel del dueño (semana 5): marca, programa, sucursales, clientes y equipo.
 * Las operaciones de saldo (sumar, canjear, ajustar, anular) están en loyalty.ts;
 * el equipo de caja y los dispositivos, en team.ts.
 */
import { can } from '@aiment/core';
import {
  anonymizeCustomer,
  createBranch,
  getCustomer,
  getSettings,
  listBranches,
  listCustomers,
  removeLogo,
  rotateCardUrl,
  setBranchActive,
  setLogo,
  setMembershipBlocked,
  updateBranch,
  updateCustomer,
  updateBranding,
  type Editor,
} from '@aiment/business';
import { applyTemplate, updateProgram } from '@aiment/ledger';
import { MAX_LOGO_BYTES } from '@aiment/storage';
import { reactivateStaffMember, updateStaffMember } from '@aiment/staff';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { isUuid, requireOrgMember, requirePermission, requireUser } from '../auth/middleware';
import type { AppEnv } from '../context';
import { HttpError, notFound } from '../errors';
import { jsonBody } from '../request';

function editor(c: Context<AppEnv>): Editor {
  const actor = c.var.actor;
  if (actor.kind !== 'member') throw new HttpError(403, 'forbidden', 'Acción no permitida');
  return { orgUserId: actor.orgUserId, actorType: 'owner' };
}

function operator(c: Context<AppEnv>) {
  const actor = c.var.actor;
  if (actor.kind !== 'member') throw new HttpError(403, 'forbidden', 'Acción no permitida');
  return {
    actorType: 'owner' as const,
    orgUserId: actor.orgUserId,
    canVoidAny: can(actor, 'ledger.void.any', actor.orgId),
    canOverrideLimits: can(actor, 'limits.override', actor.orgId),
  };
}

function uuidParam(c: Context<AppEnv>, name: string): string {
  const v = c.req.param(name);
  if (!isUuid(v)) throw notFound();
  return v;
}

const logoLimit = bodyLimit({
  maxSize: MAX_LOGO_BYTES,
  onError: () => {
    throw new HttpError(413, 'logo_too_large', 'La imagen pesa más de 1 MB. Usa una más liviana.');
  },
});

export const panelRoutes = new Hono<AppEnv>()
  .use(requireUser, requireOrgMember)

  // --- Marca ---------------------------------------------------------------
  .get('/settings', requirePermission('org.read'), async (c) =>
    c.json(await getSettings(c.var.deps.db, c.var.orgId)),
  )

  .patch('/settings', requirePermission('org.branding.update'), async (c) =>
    c.json(await updateBranding(c.var.deps.db, c.var.orgId, editor(c), await jsonBody(c))),
  )

  .put('/settings/logo', requirePermission('org.branding.update'), logoLimit, async (c) => {
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    return c.json(await setLogo(c.var.deps.db, c.var.deps.storage, c.var.orgId, editor(c), bytes));
  })

  .delete('/settings/logo', requirePermission('org.branding.update'), async (c) =>
    c.json(await removeLogo(c.var.deps.db, c.var.orgId, editor(c))),
  )

  // --- Programa (la regla y los premios, en loyalty.ts) --------------------
  .patch('/program', requirePermission('program.manage'), async (c) =>
    c.json(await updateProgram(c.var.deps.db, c.var.orgId, operator(c), await jsonBody(c))),
  )

  .post('/program/template', requirePermission('program.manage'), async (c) => {
    const b = await jsonBody(c);
    return c.json(await applyTemplate(c.var.deps.db, c.var.orgId, operator(c), b.template), 201);
  })

  // --- Sucursales ----------------------------------------------------------
  .get('/branches', requirePermission('org.read'), async (c) =>
    c.json({ branches: await listBranches(c.var.deps.db, c.var.orgId, c.var.deps.publicBaseUrl) }),
  )

  .post('/branches', requirePermission('branches.manage'), async (c) =>
    c.json(await createBranch(c.var.deps.db, c.var.orgId, editor(c), await jsonBody(c)), 201),
  )

  .patch('/branches/:branchId', requirePermission('branches.manage'), async (c) =>
    c.json(
      await updateBranch(c.var.deps.db, c.var.orgId, editor(c), uuidParam(c, 'branchId'), await jsonBody(c)),
    ),
  )

  .post('/branches/:branchId/deactivate', requirePermission('branches.manage'), async (c) =>
    c.json(await setBranchActive(c.var.deps.db, c.var.orgId, editor(c), uuidParam(c, 'branchId'), false)),
  )

  .post('/branches/:branchId/reactivate', requirePermission('branches.manage'), async (c) =>
    c.json(await setBranchActive(c.var.deps.db, c.var.orgId, editor(c), uuidParam(c, 'branchId'), true)),
  )

  // --- Clientes ------------------------------------------------------------
  .get('/customers', requirePermission('customers.read'), async (c) =>
    c.json(await listCustomers(c.var.deps.db, c.var.orgId, c.req.query())),
  )

  .get('/customers/:customerId', requirePermission('customers.read'), async (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json(await getCustomer(c.var.deps.db, c.var.orgId, uuidParam(c, 'customerId')));
  })

  .patch('/customers/:customerId', requirePermission('customers.manage'), async (c) =>
    c.json(
      await updateCustomer(
        c.var.deps.db,
        c.var.orgId,
        editor(c),
        uuidParam(c, 'customerId'),
        await jsonBody(c),
      ),
    ),
  )

  .post('/customers/:customerId/anonymize', requirePermission('customers.manage'), async (c) =>
    c.json(
      await anonymizeCustomer(
        c.var.deps.db,
        c.var.orgId,
        editor(c),
        uuidParam(c, 'customerId'),
        await jsonBody(c),
      ),
    ),
  )

  .post('/memberships/:membershipId/block', requirePermission('customers.manage'), async (c) => {
    const b = await jsonBody(c);
    return c.json(
      await setMembershipBlocked(
        c.var.deps.db,
        c.var.orgId,
        editor(c),
        uuidParam(c, 'membershipId'),
        true,
        b.reason,
      ),
    );
  })

  .post('/memberships/:membershipId/unblock', requirePermission('customers.manage'), async (c) => {
    const b = await jsonBody(c);
    return c.json(
      await setMembershipBlocked(
        c.var.deps.db,
        c.var.orgId,
        editor(c),
        uuidParam(c, 'membershipId'),
        false,
        b.reason,
      ),
    );
  })

  .post('/memberships/:membershipId/rotate-card', requirePermission('customers.manage'), async (c) =>
    c.json(await rotateCardUrl(c.var.deps.db, c.var.orgId, editor(c), uuidParam(c, 'membershipId'))),
  )

  // --- Trabajadores (alta, PIN y baja en team.ts) --------------------------
  .patch('/team/:orgUserId', requirePermission('team.manage_staff'), async (c) => {
    const b = await jsonBody(c);
    return c.json(
      await updateStaffMember(c.var.deps.db, c.var.orgId, editor(c), uuidParam(c, 'orgUserId'), {
        name: b.name,
        branchIds: b.branchIds,
      }),
    );
  })

  .post('/team/:orgUserId/reactivate', requirePermission('team.manage_staff'), async (c) => {
    await reactivateStaffMember(c.var.deps.db, c.var.orgId, editor(c), uuidParam(c, 'orgUserId'));
    return c.json({ reactivated: true });
  });
