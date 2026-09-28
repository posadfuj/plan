/**
 * Turnos de caja: en un dispositivo autorizado, la persona elige su nombre y escribe su PIN.
 * 5 intentos fallidos → bloqueo de 15 minutos. El turno dura 12 horas o hasta "Cerrar turno".
 * Un dispositivo tiene un solo turno abierto: si entra otra persona, el turno anterior se cierra.
 */
import type { OrgRole } from '@aiment/core';
import { schema, withTenantTx, type Db } from '@aiment/db';
import { hashToken, isToken, newToken } from '@aiment/enrollment';
import { and, asc, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import type { DeviceContext } from './devices';
import { StaffError } from './errors';
import { PIN_LOCK_MINUTES, PIN_MAX_ATTEMPTS, verifyPin } from './pin';

const { staffSessions, organizationUsers, auditLogs } = schema;

export const SHIFT_HOURS = 12;

/** Personas que pueden entrar a la caja de este dispositivo (tienen PIN y acceso a su sucursal). */
export async function listRegisterPeople(db: Db, device: DeviceContext) {
  const rows = await withTenantTx(db, device.orgId, (tx) =>
    tx
      .select({
        id: organizationUsers.id,
        name: organizationUsers.displayName,
        role: organizationUsers.role,
        branchIds: organizationUsers.branchIds,
      })
      .from(organizationUsers)
      .where(
        and(
          eq(organizationUsers.organizationId, device.orgId),
          eq(organizationUsers.status, 'active'),
          isNotNull(organizationUsers.pinHash),
        ),
      )
      // Primero los trabajadores de caja, luego admin y dueño.
      .orderBy(
        sql`case ${organizationUsers.role} when 'staff' then 0 when 'admin' then 1 else 2 end`,
        asc(organizationUsers.displayName),
      ),
  );
  return rows
    .filter((r) => !r.branchIds?.length || r.branchIds.includes(device.branchId))
    .map(({ branchIds: _b, ...r }) => r);
}

const wrongPin = (remaining: number) =>
  new StaffError(401, 'invalid_pin', `PIN incorrecto. Te quedan ${remaining} intentos.`, { remaining });
const locked = (until: Date) => {
  const minutes = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60_000));
  return new StaffError(
    429,
    'pin_locked',
    `Demasiados intentos. Vuelve a intentarlo en ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'} o pide al dueño que cambie tu PIN.`,
    { lockedUntil: until.toISOString() },
  );
};

type LoginOutcome =
  | { ok: true; token: string; expiresAt: Date; person: { id: string; name: string; role: OrgRole } }
  | { ok: false; error: StaffError };

/**
 * Abre un turno. Los intentos fallidos se guardan aunque la respuesta sea un error
 * (por eso la transacción devuelve el resultado en lugar de lanzar la excepción).
 */
export async function startShift(
  db: Db,
  device: DeviceContext,
  input: { personId?: unknown; pin?: unknown },
) {
  const personId = typeof input.personId === 'string' ? input.personId : '';
  const pin = typeof input.pin === 'string' ? input.pin : '';
  if (!/^[0-9a-f-]{36}$/i.test(personId)) throw wrongPin(PIN_MAX_ATTEMPTS);

  const outcome = await withTenantTx(db, device.orgId, async (tx): Promise<LoginOutcome> => {
    const [person] = await tx
      .select()
      .from(organizationUsers)
      .where(
        and(
          eq(organizationUsers.id, personId),
          eq(organizationUsers.organizationId, device.orgId),
          eq(organizationUsers.status, 'active'),
        ),
      )
      .for('update');
    if (!person?.pinHash || (person.branchIds?.length && !person.branchIds.includes(device.branchId)))
      return { ok: false, error: wrongPin(PIN_MAX_ATTEMPTS) };
    if (person.pinLockedUntil && person.pinLockedUntil > new Date())
      return { ok: false, error: locked(person.pinLockedUntil) };

    if (!(await verifyPin(person.pinHash, pin))) {
      const attempts = person.pinFailedAttempts + 1;
      const lockNow = attempts >= PIN_MAX_ATTEMPTS;
      const until = new Date(Date.now() + PIN_LOCK_MINUTES * 60_000);
      await tx
        .update(organizationUsers)
        .set(lockNow ? { pinFailedAttempts: 0, pinLockedUntil: until } : { pinFailedAttempts: attempts })
        .where(eq(organizationUsers.id, person.id));
      if (lockNow) {
        await tx.insert(auditLogs).values({
          organizationId: device.orgId,
          actorType: 'system',
          action: 'staff.pin_locked',
          entityType: 'organization_user',
          entityId: person.id,
          after: { deviceId: device.deviceId, lockedUntil: until.toISOString() },
        });
        return { ok: false, error: locked(until) };
      }
      return { ok: false, error: wrongPin(PIN_MAX_ATTEMPTS - attempts) };
    }

    await tx
      .update(organizationUsers)
      .set({ pinFailedAttempts: 0, pinLockedUntil: null })
      .where(eq(organizationUsers.id, person.id));
    // Un turno por dispositivo: el que estaba abierto se cierra.
    await tx
      .update(staffSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(staffSessions.deviceId, device.deviceId), isNull(staffSessions.revokedAt)));
    const token = newToken();
    const expiresAt = new Date(Date.now() + SHIFT_HOURS * 3_600_000);
    const [session] = await tx
      .insert(staffSessions)
      .values({
        organizationId: device.orgId,
        deviceId: device.deviceId,
        organizationUserId: person.id,
        tokenHash: hashToken(token),
        expiresAt,
      })
      .returning({ id: staffSessions.id });
    await tx.insert(auditLogs).values({
      organizationId: device.orgId,
      actorType: person.role === 'staff' ? 'staff' : 'owner',
      actorId: person.id,
      action: 'staff.shift_started',
      entityType: 'staff_session',
      entityId: session!.id,
      after: { deviceId: device.deviceId },
    });
    return {
      ok: true,
      token,
      expiresAt,
      person: { id: person.id, name: person.displayName, role: person.role },
    };
  });
  if (!outcome.ok) throw outcome.error;
  return outcome;
}

export interface ShiftContext {
  sessionId: string;
  orgUserId: string;
  name: string;
  role: OrgRole;
  expiresAt: Date;
}

/** Turno abierto de este dispositivo para el token de la cookie (null si venció o se cerró). */
export async function resolveShift(
  db: Db,
  device: DeviceContext,
  token: string | undefined,
): Promise<ShiftContext | null> {
  if (!isToken(token)) return null;
  const [row] = await withTenantTx(db, device.orgId, (tx) =>
    tx
      .select({
        sessionId: staffSessions.id,
        orgUserId: organizationUsers.id,
        name: organizationUsers.displayName,
        role: organizationUsers.role,
        expiresAt: staffSessions.expiresAt,
        branchIds: organizationUsers.branchIds,
      })
      .from(staffSessions)
      .innerJoin(organizationUsers, eq(organizationUsers.id, staffSessions.organizationUserId))
      .where(
        and(
          eq(staffSessions.tokenHash, hashToken(token)),
          eq(staffSessions.deviceId, device.deviceId),
          eq(staffSessions.organizationId, device.orgId),
          isNull(staffSessions.revokedAt),
          gt(staffSessions.expiresAt, sql`now()`),
          eq(organizationUsers.status, 'active'),
        ),
      ),
  );
  if (!row) return null;
  // Si el dueño le quitó esta sucursal, el turno deja de valer aunque no haya vencido.
  const { branchIds, ...shift } = row;
  if (branchIds?.length && !branchIds.includes(device.branchId)) return null;
  return shift;
}

/** "Cerrar turno". */
export async function endShift(db: Db, device: DeviceContext, shift: ShiftContext) {
  await withTenantTx(db, device.orgId, async (tx) => {
    await tx
      .update(staffSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(staffSessions.id, shift.sessionId), isNull(staffSessions.revokedAt)));
    await tx.insert(auditLogs).values({
      organizationId: device.orgId,
      actorType: shift.role === 'staff' ? 'staff' : 'owner',
      actorId: shift.orgUserId,
      action: 'staff.shift_closed',
      entityType: 'staff_session',
      entityId: shift.sessionId,
      after: { deviceId: device.deviceId },
    });
  });
}
