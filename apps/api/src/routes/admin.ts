import {
  activateBusiness,
  changePlan,
  createBusiness,
  listOrganizations,
  listPlans,
  platformAudit,
  resendOwnerInvitation,
} from '@aiment/business';
import { schema, withSystemTx } from '@aiment/db';
import { eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { isUuid, requireSuperadmin, requireUser } from '../auth/middleware';
import type { AppEnv } from '../context';
import { HttpError, notFound } from '../errors';
import { jsonBody } from '../request';

const { organizations, auditLogs } = schema;
const reasonBody = z.object({ reason: z.string().trim().min(5).max(500) });

function orgParam(c: Context<AppEnv>) {
  const orgId = c.req.param('orgId');
  if (!isUuid(orgId)) throw notFound();
  return orgId;
}

function platformDeps(c: Context<AppEnv>) {
  const { db, mailer, publicBaseUrl, authAdmin } = c.var.deps;
  return { db, mailer, publicBaseUrl, authAdmin };
}

/**
 * Panel maestro del fundador. Muestra uso agregado por negocio, nunca datos personales de clientes
 * (eso será el "modo soporte" auditado de la fase 2).
 */
export const adminRoutes = new Hono<AppEnv>()
  .use(requireUser)

  .get('/orgs', requireSuperadmin('platform.orgs.read'), async (c) =>
    c.json({ organizations: await listOrganizations(c.var.deps.db) }),
  )

  .get('/plans', requireSuperadmin('platform.orgs.read'), async (c) => c.json(await listPlans(c.var.deps.db)))

  .get('/audit', requireSuperadmin('platform.audit.read'), async (c) =>
    c.json({ entries: await platformAudit(c.var.deps.db) }),
  )

  .post('/orgs', requireSuperadmin('platform.orgs.create'), async (c) =>
    c.json(await createBusiness(platformDeps(c), c.var.user.id, await jsonBody(c)), 201),
  )

  .post('/orgs/:orgId/invite', requireSuperadmin('platform.orgs.create'), async (c) =>
    c.json(await resendOwnerInvitation(platformDeps(c), c.var.user.id, orgParam(c))),
  )

  .post('/orgs/:orgId/activate', requireSuperadmin('platform.orgs.create'), async (c) =>
    c.json(await activateBusiness(c.var.deps.db, c.var.user.id, orgParam(c))),
  )

  .post('/orgs/:orgId/plan', requireSuperadmin('platform.plans.manage'), async (c) => {
    const b = await jsonBody(c);
    return c.json(await changePlan(c.var.deps.db, c.var.user.id, orgParam(c), b.planCode));
  })

  .post('/orgs/:orgId/suspend', requireSuperadmin('platform.orgs.suspend'), async (c) => {
    const { reason } = reasonBody.parse(await c.req.json().catch(() => ({})));
    return c.json(await setStatus(c, 'suspended', reason));
  })

  .post('/orgs/:orgId/reactivate', requireSuperadmin('platform.orgs.suspend'), async (c) => {
    const { reason } = reasonBody.parse(await c.req.json().catch(() => ({})));
    return c.json(await setStatus(c, 'live', reason));
  });

async function setStatus(c: Context<AppEnv>, status: 'suspended' | 'live', reason: string) {
  const orgId = orgParam(c);
  return withSystemTx(c.var.deps.db, async (tx) => {
    const [org] = await tx
      .select({ status: organizations.status })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .for('update');
    if (!org) throw notFound();
    if (org.status === status)
      throw new HttpError(409, 'no_change', `El negocio ya está en estado ${status}`);
    // Reactivar es solo para suspendidos: un borrador se publica con /activate.
    if (status === 'live' && org.status !== 'suspended')
      throw new HttpError(409, 'not_suspended', 'Solo se reactiva un negocio suspendido');
    // Suspender no borra nada: solo bloquea el acceso. El historial queda intacto.
    await tx.update(organizations).set({ status, updatedAt: new Date() }).where(eq(organizations.id, orgId));
    await tx.insert(auditLogs).values({
      organizationId: orgId,
      actorType: 'superadmin',
      actorId: c.var.user.id,
      action: status === 'suspended' ? 'org.suspended' : 'org.reactivated',
      entityType: 'organization',
      entityId: orgId,
      before: { status: org.status },
      after: { status, reason },
    });
    return { id: orgId, status };
  });
}
