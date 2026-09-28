import { can, type OrgAction, type PlatformAction } from '@aiment/core';
import { schema, withSystemTx, withTenantTx } from '@aiment/db';
import { and, eq } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../context';
import { HttpError, notFound } from '../errors';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string | undefined): v is string => !!v && UUID_RE.test(v);

/** Exige un access token válido de Supabase Auth y un usuario dado de alta en Aiment Wallet. */
export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new HttpError(401, 'missing_token', 'Falta el token de sesión');
  const { db, verifier } = c.var.deps;
  const claims = await verifier.verify(token);

  const [user] = await withSystemTx(db, (tx) =>
    tx
      .select({
        id: schema.users.id,
        email: schema.users.email,
        fullName: schema.users.fullName,
        isSuperadmin: schema.users.isSuperadmin,
      })
      .from(schema.users)
      .where(eq(schema.users.id, claims.userId)),
  );
  if (!user) throw new HttpError(403, 'user_not_provisioned', 'Usuario sin acceso a Aiment Wallet');
  c.set('claims', claims);
  c.set('user', user);
  await next();
});

/** Rutas de plataforma: solo superadmin, con TOTP (aal2) cuando la configuración lo exige. */
export const requireSuperadmin = (action: PlatformAction) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const { user, claims } = c.var;
    if (!user.isSuperadmin) throw notFound();
    if (c.var.deps.config.requireSuperadminMfa && claims.aal !== 'aal2')
      throw new HttpError(403, 'mfa_required', 'El superadmin debe verificar su segundo factor (TOTP)');
    const actor = { kind: 'superadmin', userId: user.id } as const;
    if (!can(actor, action)) throw new HttpError(403, 'forbidden', 'Acción no permitida');
    c.set('actor', actor);
    await next();
  });

/**
 * Resuelve la membresía del usuario en la organización de la ruta (/v1/orgs/:orgId/...).
 * Si no pertenece, responde 404: no se revela si la organización existe.
 */
export const requireOrgMember = createMiddleware<AppEnv>(async (c, next) => {
  const orgId = c.req.param('orgId');
  if (!isUuid(orgId)) throw notFound();
  const { db } = c.var.deps;
  const row = await withTenantTx(db, orgId, async (tx) => {
    const [r] = await tx
      .select({
        orgUserId: schema.organizationUsers.id,
        role: schema.organizationUsers.role,
        orgStatus: schema.organizations.status,
      })
      .from(schema.organizationUsers)
      .innerJoin(schema.organizations, eq(schema.organizations.id, schema.organizationUsers.organizationId))
      .where(
        and(
          eq(schema.organizationUsers.organizationId, orgId),
          eq(schema.organizationUsers.userId, c.var.user.id),
          eq(schema.organizationUsers.status, 'active'),
        ),
      );
    return r;
  });
  if (!row) throw notFound();
  if (row.orgStatus === 'suspended' || row.orgStatus === 'cancelled')
    throw new HttpError(
      403,
      'org_suspended',
      'Este negocio está suspendido. Contacta a soporte de Aiment Wallet.',
    );
  c.set('orgId', orgId);
  c.set('actor', { kind: 'member', userId: c.var.user.id, orgId, orgUserId: row.orgUserId, role: row.role });
  await next();
});

export const requirePermission = (action: OrgAction) =>
  createMiddleware<AppEnv>(async (c, next) => {
    if (!can(c.var.actor, action, c.var.orgId))
      throw new HttpError(403, 'forbidden', 'Tu rol no permite esta acción');
    await next();
  });
