/**
 * Equipo de caja desde el panel: alta de trabajadores con PIN, cambio de PIN y baja.
 * También el PIN del dueño/admin, que en caja autoriza excepciones de límites.
 */
import { assertBranchIds, assertWithinPlan } from '@aiment/business';
import { schema, withTenantTx, type Db, type Tx } from '@aiment/db';
import { and, asc, eq, inArray, isNotNull, isNull, ne, notInArray, sql } from 'drizzle-orm';
import type { Manager } from './devices';
import { StaffError, notFound } from './errors';
import { assertValidPin, hashPin, verifyPin } from './pin';

const { organizationUsers, staffSessions, workerDevices, auditLogs } = schema;

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
        /** Vacío = puede entrar a la caja de cualquier sucursal. */
        branchIds: organizationUsers.branchIds,
      })
      .from(organizationUsers)
      .where(eq(organizationUsers.organizationId, orgId))
      .orderBy(
        sql`case ${organizationUsers.role} when 'owner' then 0 when 'admin' then 1 else 2 end`,
        asc(organizationUsers.displayName),
      ),
  );
  const now = new Date();
  return rows.map((r) => ({
    ...r,
    branchIds: r.branchIds ?? [],
    locked: !!r.lockedUntil && r.lockedUntil > now,
  }));
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Sucursales donde puede abrir turno ([] = todas). */
function cleanBranchIds(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 50 || !raw.every((v) => typeof v === 'string' && UUID_RE.test(v)))
    throw new StaffError(422, 'invalid_branch', 'Elige sucursales activas del negocio');
  return [...new Set(raw as string[])];
}

async function assertNameFree(tx: Tx, orgId: string, name: string, exceptId?: string) {
  const [dup] = await tx
    .select({ id: organizationUsers.id })
    .from(organizationUsers)
    .where(
      and(
        eq(organizationUsers.organizationId, orgId),
        eq(organizationUsers.status, 'active'),
        sql`lower(${organizationUsers.displayName}) = lower(${name})`,
        exceptId ? ne(organizationUsers.id, exceptId) : undefined,
      ),
    );
  if (dup) throw new StaffError(409, 'name_taken', 'Ya hay alguien del equipo con ese nombre');
}

/** Cierra los turnos abiertos de una persona en cajas de sucursales donde ya no puede trabajar. */
async function closeShiftsOutside(tx: Tx, personId: string, branchIds: string[]) {
  if (!branchIds.length) return;
  await tx
    .update(staffSessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(staffSessions.organizationUserId, personId),
        isNull(staffSessions.revokedAt),
        inArray(
          staffSessions.deviceId,
          tx
            .select({ id: workerDevices.id })
            .from(workerDevices)
            .where(notInArray(workerDevices.branchId, branchIds)),
        ),
      ),
    );
}

/**
 * Edita a un trabajador de caja: nombre y sucursales donde puede abrir turno. Si pierde acceso a una
 * sucursal donde tiene un turno abierto, ese turno se cierra en ese momento.
 */
export async function updateStaffMember(
  db: Db,
  orgId: string,
  manager: Manager,
  targetId: string,
  input: { name?: unknown; branchIds?: unknown },
) {
  const name = input.name === undefined ? undefined : cleanPersonName(input.name);
  const branchIds = input.branchIds === undefined ? undefined : cleanBranchIds(input.branchIds);
  return withTenantTx(db, orgId, async (tx) => {
    const [cur] = await tx
      .select()
      .from(organizationUsers)
      .where(
        and(
          eq(organizationUsers.id, targetId),
          eq(organizationUsers.organizationId, orgId),
          eq(organizationUsers.role, 'staff'),
          eq(organizationUsers.status, 'active'),
        ),
      )
      .for('update');
    if (!cur) throw notFound();
    if (name) await assertNameFree(tx, orgId, name, cur.id);
    if (branchIds) await assertBranchIds(tx, orgId, branchIds);
    await tx
      .update(organizationUsers)
      .set({ displayName: name ?? cur.displayName, branchIds: branchIds ?? cur.branchIds })
      .where(eq(organizationUsers.id, cur.id));
    if (branchIds) await closeShiftsOutside(tx, cur.id, branchIds);
    await tx.insert(auditLogs).values({
      organizationId: orgId,
      actorType: manager.actorType,
      actorId: manager.orgUserId,
      action: 'team.staff_updated',
      entityType: 'organization_user',
      entityId: cur.id,
      before: { name: cur.displayName, branchIds: cur.branchIds ?? [] },
      after: { name: name ?? cur.displayName, branchIds: branchIds ?? cur.branchIds ?? [] },
    });
    return { id: cur.id, name: name ?? cur.displayName, branchIds: branchIds ?? cur.branchIds ?? [] };
  });
}

/** Reactiva a un trabajador dado de baja (cuenta para el tope del plan). Conserva su PIN. */
export async function reactivateStaffMember(db: Db, orgId: string, manager: Manager, targetId: string) {
  await withTenantTx(db, orgId, async (tx) => {
    const [cur] = await tx
      .select({ id: organizationUsers.id, name: organizationUsers.displayName })
      .from(organizationUsers)
      .where(
        and(
          eq(organizationUsers.id, targetId),
          eq(organizationUsers.organizationId, orgId),
          eq(organizationUsers.role, 'staff'),
          eq(organizationUsers.status, 'inactive'),
        ),
      )
      .for('update');
    if (!cur) throw notFound();
    await assertWithinPlan(tx, orgId, 'staff');
    await assertNameFree(tx, orgId, cur.name);
    await tx
      .update(organizationUsers)
      .set({ status: 'active', pinFailedAttempts: 0, pinLockedUntil: null })
      .where(eq(organizationUsers.id, cur.id));
    await tx.insert(auditLogs).values({
      organizationId: orgId,
      actorType: manager.actorType,
      actorId: manager.orgUserId,
      action: 'team.staff_reactivated',
      entityType: 'organization_user',
      entityId: cur.id,
      after: { name: cur.name },
    });
  });
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
  input: { name?: unknown; pin?: unknown; branchIds?: unknown },
) {
  const name = cleanPersonName(input.name);
  const branchIds = cleanBranchIds(input.branchIds);
  assertValidPin(input.pin);
  const pinHash = await hashPin(input.pin);
  return withTenantTx(db, orgId, async (tx) => {
    await assertWithinPlan(tx, orgId, 'staff');
    await assertBranchIds(tx, orgId, branchIds);
    await assertNameFree(tx, orgId, name);
    const [row] = await tx
      .insert(organizationUsers)
      .values({ organizationId: orgId, displayName: name, role: 'staff', pinHash, branchIds })
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
      after: { name, branchIds },
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
