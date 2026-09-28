import { schema, withTenantTx } from '@aiment/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { requireOrgMember, requirePermission, requireUser } from '../auth/middleware';
import type { AppEnv } from '../context';

const { organizations, loyaltyPrograms, auditLogs } = schema;

export const orgRoutes = new Hono<AppEnv>()
  .use(requireUser, requireOrgMember)

  .get('/', requirePermission('org.read'), async (c) => {
    const orgId = c.var.orgId;
    const data = await withTenantTx(c.var.deps.db, orgId, async (tx) => {
      const [org] = await tx
        .select({
          id: organizations.id,
          name: organizations.name,
          slug: organizations.slug,
          status: organizations.status,
          plan: organizations.planCode,
          timezone: organizations.timezone,
        })
        .from(organizations)
        .where(eq(organizations.id, orgId));
      const [program] = await tx
        .select({
          id: loyaltyPrograms.id,
          name: loyaltyPrograms.name,
          mode: loyaltyPrograms.mode,
          unitLabel: loyaltyPrograms.unitLabel,
        })
        .from(loyaltyPrograms)
        .where(and(eq(loyaltyPrograms.organizationId, orgId), eq(loyaltyPrograms.status, 'active')));
      const [stats] = await tx
        .select({
          customers: sql<number>`(select count(*)::int from app.customers where organization_id = ${orgId} and status = 'active')`,
          movements30d: sql<number>`(select count(*)::int from app.ledger_entries where organization_id = ${orgId} and created_at > now() - interval '30 days')`,
          rewardsAvailable: sql<number>`(select count(*)::int from app.earned_rewards where organization_id = ${orgId} and status = 'available')`,
        })
        .from(sql`(select 1) as one`);
      return {
        ...org,
        program: program ?? null,
        stats,
        role: c.var.actor.kind === 'member' ? c.var.actor.role : null,
      };
    });
    return c.json(data);
  })

  .get('/audit', requirePermission('audit.read'), async (c) => {
    const orgId = c.var.orgId;
    const rows = await withTenantTx(c.var.deps.db, orgId, (tx) =>
      tx
        .select({
          id: auditLogs.id,
          actorType: auditLogs.actorType,
          action: auditLogs.action,
          entityType: auditLogs.entityType,
          createdAt: auditLogs.createdAt,
          after: auditLogs.after,
        })
        .from(auditLogs)
        .where(eq(auditLogs.organizationId, orgId))
        .orderBy(desc(auditLogs.createdAt))
        .limit(100),
    );
    return c.json({ entries: rows });
  });
