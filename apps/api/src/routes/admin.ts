import { schema, withSystemTx } from '@aiment/db';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { isUuid, requireSuperadmin, requireUser } from '../auth/middleware';
import type { AppEnv } from '../context';
import { HttpError, notFound } from '../errors';

const { organizations, auditLogs } = schema;
// Referencia explícita a la fila externa en las subconsultas correlacionadas.
const orgRef = sql.raw('"organizations"."id"');
const reasonBody = z.object({ reason: z.string().trim().min(5).max(500) });

/**
 * Panel maestro del fundador. Muestra uso agregado por negocio, nunca datos personales de clientes
 * (eso será el "modo soporte" auditado de la fase 2).
 */
export const adminRoutes = new Hono<AppEnv>()
  .use(requireUser)

  .get('/orgs', requireSuperadmin('platform.orgs.read'), async (c) => {
    const rows = await withSystemTx(c.var.deps.db, (tx) =>
      tx
        .select({
          id: organizations.id,
          name: organizations.name,
          slug: organizations.slug,
          status: organizations.status,
          plan: organizations.planCode,
          customers: sql<number>`(select count(*)::int from app.customers c where c.organization_id = ${orgRef})`,
          movements30d: sql<number>`(select count(*)::int from app.ledger_entries l where l.organization_id = ${orgRef} and l.created_at > now() - interval '30 days')`,
          walletPasses: sql<number>`(select count(*)::int from app.wallet_passes w where w.organization_id = ${orgRef} and w.status = 'active')`,
        })
        .from(organizations)
        .orderBy(organizations.name),
    );
    return c.json({ organizations: rows });
  })

  .post('/orgs/:orgId/suspend', requireSuperadmin('platform.orgs.suspend'), async (c) => {
    const { reason } = reasonBody.parse(await c.req.json().catch(() => ({})));
    return c.json(await setStatus(c, 'suspended', reason));
  })

  .post('/orgs/:orgId/reactivate', requireSuperadmin('platform.orgs.suspend'), async (c) => {
    const { reason } = reasonBody.parse(await c.req.json().catch(() => ({})));
    return c.json(await setStatus(c, 'live', reason));
  });

async function setStatus(
  c: {
    req: { param: (k: string) => string | undefined; header: (k: string) => string | undefined };
    var: AppEnv['Variables'];
  },
  status: 'suspended' | 'live',
  reason: string,
) {
  const orgId = c.req.param('orgId');
  if (!isUuid(orgId)) throw notFound();
  return withSystemTx(c.var.deps.db, async (tx) => {
    const [org] = await tx
      .select({ status: organizations.status })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .for('update');
    if (!org) throw notFound();
    if (org.status === status)
      throw new HttpError(409, 'no_change', `El negocio ya está en estado ${status}`);
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
