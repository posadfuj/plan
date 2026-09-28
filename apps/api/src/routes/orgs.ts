import { schema, withTenantTx } from '@aiment/db';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { isUuid, requireOrgMember, requirePermission, requireUser } from '../auth/middleware';
import type { AppEnv } from '../context';
import { notFound } from '../errors';

const {
  organizations,
  loyaltyPrograms,
  customers,
  memberships,
  ledgerEntries,
  earnedRewards,
  rewards,
  auditLogs,
} = schema;

const listQuery = z.object({
  q: z.string().trim().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

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

  .get('/customers', requirePermission('customers.read'), async (c) => {
    const { q, limit } = listQuery.parse(c.req.query());
    const orgId = c.var.orgId;
    const rows = await withTenantTx(c.var.deps.db, orgId, (tx) =>
      tx
        .select({
          id: customers.id,
          fullName: customers.fullName,
          phone: customers.phoneE164,
          membershipId: memberships.id,
          shortCode: memberships.shortCode,
          balance: memberships.balance,
          lastActivityAt: memberships.lastActivityAt,
        })
        .from(customers)
        .leftJoin(memberships, eq(memberships.customerId, customers.id))
        .where(
          and(
            eq(customers.organizationId, orgId),
            eq(customers.status, 'active'),
            q ? or(ilike(customers.fullName, `%${q}%`), ilike(customers.phoneE164, `%${q}%`)) : undefined,
          ),
        )
        .orderBy(desc(memberships.lastActivityAt))
        .limit(limit),
    );
    return c.json({ customers: rows });
  })

  .get('/customers/:customerId', requirePermission('customers.read'), async (c) => {
    const customerId = c.req.param('customerId');
    if (!isUuid(customerId)) throw notFound();
    const orgId = c.var.orgId;
    const data = await withTenantTx(c.var.deps.db, orgId, async (tx) => {
      const [customer] = await tx
        .select({
          id: customers.id,
          fullName: customers.fullName,
          phone: customers.phoneE164,
          email: customers.email,
          createdAt: customers.createdAt,
        })
        .from(customers)
        .where(and(eq(customers.id, customerId), eq(customers.organizationId, orgId)));
      if (!customer) return null;
      const [membership] = await tx
        .select({
          id: memberships.id,
          balance: memberships.balance,
          lifetimeEarned: memberships.lifetimeEarned,
          shortCode: memberships.shortCode,
          status: memberships.status,
        })
        .from(memberships)
        .where(and(eq(memberships.customerId, customerId), eq(memberships.organizationId, orgId)));
      const movements = membership
        ? await tx
            .select({
              id: ledgerEntries.id,
              kind: ledgerEntries.kind,
              delta: ledgerEntries.delta,
              balanceAfter: ledgerEntries.balanceAfter,
              createdAt: ledgerEntries.createdAt,
            })
            .from(ledgerEntries)
            .where(
              and(eq(ledgerEntries.membershipId, membership.id), eq(ledgerEntries.organizationId, orgId)),
            )
            .orderBy(desc(ledgerEntries.createdAt))
            .limit(20)
        : [];
      const earned = membership
        ? await tx
            .select({
              id: earnedRewards.id,
              reward: rewards.name,
              status: earnedRewards.status,
              expiresAt: earnedRewards.expiresAt,
            })
            .from(earnedRewards)
            .innerJoin(rewards, eq(rewards.id, earnedRewards.rewardId))
            .where(
              and(eq(earnedRewards.membershipId, membership.id), eq(earnedRewards.organizationId, orgId)),
            )
            .orderBy(desc(earnedRewards.createdAt))
        : [];
      return { customer, membership: membership ?? null, movements, earnedRewards: earned };
    });
    if (!data) throw notFound();
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
