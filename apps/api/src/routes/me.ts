import { schema, withSystemTx } from '@aiment/db';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { requireUser } from '../auth/middleware';
import type { AppEnv } from '../context';

export const meRoutes = new Hono<AppEnv>().use(requireUser).get('/', async (c) => {
  const { user } = c.var;
  // Consulta de plataforma acotada al propio usuario: lista sus negocios y roles.
  const orgs = await withSystemTx(c.var.deps.db, (tx) =>
    tx
      .select({
        id: schema.organizations.id,
        name: schema.organizations.name,
        slug: schema.organizations.slug,
        status: schema.organizations.status,
        role: schema.organizationUsers.role,
      })
      .from(schema.organizationUsers)
      .innerJoin(schema.organizations, eq(schema.organizations.id, schema.organizationUsers.organizationId))
      .where(and(eq(schema.organizationUsers.userId, user.id), eq(schema.organizationUsers.status, 'active')))
      .orderBy(schema.organizations.name),
  );
  return c.json({ user: { ...user, aal: c.var.claims.aal }, organizations: orgs });
});
