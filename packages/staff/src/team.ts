/**
 * Equipo de caja desde el panel: alta de trabajadores con PIN, cambio de PIN y baja.
 * También el PIN del dueño/admin, que en caja autoriza excepciones de límites.
 */
import { schema, withTenantTx, type Db } from '@aiment/db';
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Manager } from './devices';
import { StaffError, notFound } from './errors';
import { assertValidPin, hashPin, verifyPin } from './pin';

const { organizationUsers, staffSessions, auditLogs } = schema;

export async function listTeam(db: Db, orgId: string) {
  const rows = await withTenantTx(db, orgId, (tx) =>
    tx
      .select({
        id: organizationUsers.id,
        name: organizationUsers.displayName,
        role: organizationUsers.role,
        status: organizationUsers.status,
        hasPin: sql<boolean>`${organizationUsers.pinHash} is not null`,
        lockedUntil: organizationUsers.pinLockedUntil,
      })
      .from(organizationUsers)
      .where(eq(organizationUsers.organizationId, orgId))
      .orderBy(
        sql`case ${organizationUsers.role} when 'owner' then 0 when 'admin' then 1 else 2 end`,
        asc(organizationUsers.displayName),
      ),
  );
  const now = new Date();
  return rows.map((r) => ({ ...r, locked: !!r.lockedUntil && r.lockedUntil > now }));
}

function cleanPersonName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (!/^[\p{L}][\p{L}\p{M}0-9' ().-]{1,39}$/u.test(name))
    throw new StaffError(422, 'invalid_name', 'Escribe el nombre del trabajador (2 a 40 caracteres)');
  return name;
}

export async function createStaffMember(
  db: Db,
  orgId: string,
  manager: Manager,
  input: { name?: unknown; pin?: unknown },
) {
  const name = cleanPersonName(input.name);
  assertValidPin(input.pin);
  const pinHash = await hashPin(input.pin);
  return withTenantTx(db, orgId, async (tx) => {
    const [dup] = await tx
      .select({ id: organizationUsers.id })
      .from(organizationUsers)
      .where(
        and(
          eq(organizationUsers.organizationId, orgId),
          eq(organizationUsers.status, 'active'),
          sql`lower(${organizationUsers.displayName}) = lower(${name})`,
        ),
      );
    if (dup) throw new StaffError(409, 'name_taken', 'Ya hay alguien del equipo con ese nombre');
    const [row] = await tx
      .insert(organizationUsers)
      .values({ organizationId: orgId, displayName: name, role: 'staff', pinHash })
      .returning({
        id: organizationUsers.id,
        name: organizationUsers.displayName,
        role: organizationUsers.role,
      });
    await tx.insert(auditLogs).values({
      organizationId: orgId,
      actorType: manager.actorType,
      actorId: manager.orgUserId,
      action: 'team.staff_created',
      entityType: 'organization_user',
      entityId: row!.id,
      after: { name },
    });
    return row!;
  });
}

/**
 * Cambia el PIN de una persona. Cada quien puede cambiar el suyo; el de un trabajador de caja
 * también lo puede cambiar quien gestiona el equipo. Cambiar el PIN desbloquea y cierra sus turnos.
 */
export async function setPin(
  db: Db,
  orgId: string,
  manager: Manager & { canManageStaff: boolean },
  targetId: string,
  pin: unknown,
) {
  assertValidPin(pin);
  const pinHash = await hashPin(pin);
  await withTenantTx(db, orgId, async (tx) => {
    const [target] = await tx
      .select({ id: organizationUsers.id, role: organizationUsers.role })
      .from(organizationUsers)
      .where(
        and(
          eq(organizationUsers.id, targetId),
          eq(organizationUsers.organizationId, orgId),
          eq(organizationUsers.status, 'active'),
        ),
      );
    if (!target) throw notFound();
    const self = target.id === manager.orgUserId;
    if (!self && !(target.role === 'staff' && manager.canManageStaff))
      throw new StaffError(403, 'forbidden', 'Solo puedes cambiar tu PIN o el de los trabajadores de caja');
    await tx
      .update(organizationUsers)
      .set({ pinHash, pinFailedAttempts: 0, pinLockedUntil: null })
      .where(eq(organizationUsers.id, target.id));
    await tx
      .update(staffSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(staffSessions.organizationUserId, target.id), isNull(staffSessions.revokedAt)));
    await tx.insert(auditLogs).values({
      organizationId: orgId,
      actorType: manager.actorType,
      actorId: manager.orgUserId,
      action: 'team.pin_changed',
      entityType: 'organization_user',
      entityId: target.id,
      after: { self },
    });
  });
}

/** Baja de un trabajador de caja: no puede volver a entrar y sus turnos abiertos se cierran. */
export async function deactivateStaffMember(db: Db, orgId: string, manager: Manager, targetId: string) {
  await withTenantTx(db, orgId, async (tx) => {
    const [target] = await tx
      .update(organizationUsers)
      .set({ status: 'inactive' })
      .where(
        and(
          eq(organizationUsers.id, targetId),
          eq(organizationUsers.organizationId, orgId),
          eq(organizationUsers.role, 'staff'),
          eq(organizationUsers.status, 'active'),
        ),
      )
      .returning({ id: organizationUsers.id, name: organizationUsers.displayName });
    if (!target) throw notFound();
    await tx
      .update(staffSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(staffSessions.organizationUserId, target.id), isNull(staffSessions.revokedAt)));
    await tx.insert(auditLogs).values({
      organizationId: orgId,
      actorType: manager.actorType,
      actorId: manager.orgUserId,
      action: 'team.staff_deactivated',
      entityType: 'organization_user',
      entityId: target.id,
      after: { name: target.name },
    });
  });
}

/**
 * PIN del dueño o de un admin para autorizar en caja una excepción de límites.
 * Devuelve quién la autorizó, o null si el PIN no corresponde a nadie con ese permiso.
 */
export async function verifyOverridePin(
  db: Db,
  orgId: string,
  pin: unknown,
): Promise<{ orgUserId: string; name: string } | null> {
  if (typeof pin !== 'string' || !/^\d{4,6}$/.test(pin)) return null;
  const approvers = await withTenantTx(db, orgId, (tx) =>
    tx
      .select({
        id: organizationUsers.id,
        name: organizationUsers.displayName,
        pinHash: organizationUsers.pinHash,
      })
      .from(organizationUsers)
      .where(
        and(
          eq(organizationUsers.organizationId, orgId),
          eq(organizationUsers.status, 'active'),
          inArray(organizationUsers.role, ['owner', 'admin']),
          isNotNull(organizationUsers.pinHash),
        ),
      ),
  );
  for (const a of approvers) if (await verifyPin(a.pinHash, pin)) return { orgUserId: a.id, name: a.name };
  return null;
}
