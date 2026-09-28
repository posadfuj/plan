/**
 * Dispositivos de caja. El dueño (o admin) genera desde el panel un QR de un solo uso (10 min);
 * el celular o tablet que lo abre queda autorizado y recibe un secreto que guarda en una cookie
 * httpOnly. En la base solo queda el hash del secreto: revocar el dispositivo lo deja sin acceso.
 */
import { schema, withSystemTx, withTenantTx, type Db } from '@aiment/db';
import { hashToken, isToken, newToken } from '@aiment/enrollment';
import { and, asc, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import QRCode from 'qrcode';
import { StaffError, notFound } from './errors';
import { UUID_RE } from './team';

const {
  devicePairings,
  workerDevices,
  staffSessions,
  branches,
  organizations,
  organizationUsers,
  auditLogs,
} = schema;

export const PAIRING_MINUTES = 10;
export const DEVICE_COOKIE_DAYS = 180;
/** No se reescribe last_seen_at en cada petición: basta con saber si se usó en los últimos minutos. */
const LAST_SEEN_EVERY_MS = 5 * 60_000;

export interface Manager {
  orgUserId: string;
  actorType: 'owner';
}

function cleanName(raw: unknown, what: string): string {
  const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (name.length < 2 || name.length > 40)
    throw new StaffError(422, 'invalid_name', `Escribe un nombre para ${what} (2 a 40 caracteres)`);
  return name;
}

export function pairingUrl(publicBaseUrl: string, code: string): string {
  return `${publicBaseUrl.replace(/\/$/, '')}/caja/vincular/${code}`;
}

/** Genera el QR de autorización de un dispositivo (un solo uso, 10 minutos). */
export async function createPairing(
  db: Db,
  orgId: string,
  manager: Manager,
  input: { name?: unknown; branchId?: unknown },
  publicBaseUrl: string,
) {
  const name = cleanName(input.name, 'el dispositivo');
  // Sin sucursal (o vacía, si el panel aún no cargó la lista): la primera activa. Un id mal formado
  // es una sucursal que no existe, no un error interno.
  const branchId = typeof input.branchId === 'string' && input.branchId !== '' ? input.branchId : null;
  if (branchId !== null && !UUID_RE.test(branchId)) throw notFound();
  const code = newToken();
  const expiresAt = new Date(Date.now() + PAIRING_MINUTES * 60_000);
  await withTenantTx(db, orgId, async (tx) => {
    const [branch] = await tx
      .select({ id: branches.id })
      .from(branches)
      .where(
        and(
          eq(branches.organizationId, orgId),
          eq(branches.status, 'active'),
          branchId ? eq(branches.id, branchId) : undefined,
        ),
      )
      .orderBy(asc(branches.createdAt))
      .limit(1);
    if (!branch) throw notFound();
    const [row] = await tx
      .insert(devicePairings)
      .values({
        organizationId: orgId,
        branchId: branch.id,
        name,
        codeHash: hashToken(code),
        createdBy: manager.orgUserId,
        expiresAt,
      })
      .returning({ id: devicePairings.id });
    await tx.insert(auditLogs).values({
      organizationId: orgId,
      actorType: manager.actorType,
      actorId: manager.orgUserId,
      action: 'device.pairing_created',
      entityType: 'device_pairing',
      entityId: row!.id,
      after: { name, branchId: branch.id, expiresAt: expiresAt.toISOString() },
    });
  });
  const url = pairingUrl(publicBaseUrl, code);
  return {
    url,
    expiresAt,
    qrSvg: await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }),
  };
}

const invalidPairing = () =>
  new StaffError(410, 'pairing_invalid', 'Este QR de autorización ya no es válido. Pide uno nuevo al dueño.');

/**
 * El dispositivo abre el QR: se marca como usado (una sola vez, aunque lleguen dos a la vez)
 * y se crea el dispositivo. Devuelve el secreto para la cookie; no se vuelve a mostrar.
 */
export async function claimPairing(db: Db, code: string) {
  if (!isToken(code)) throw invalidPairing();
  const [found] = await withSystemTx(db, (tx) =>
    tx
      .select({ id: devicePairings.id, orgId: devicePairings.organizationId })
      .from(devicePairings)
      .innerJoin(organizations, eq(organizations.id, devicePairings.organizationId))
      .where(and(eq(devicePairings.codeHash, hashToken(code)), eq(organizations.status, 'live'))),
  );
  if (!found) throw invalidPairing();

  const secret = newToken();
  const device = await withTenantTx(db, found.orgId, async (tx) => {
    const [pairing] = await tx
      .update(devicePairings)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(devicePairings.id, found.id),
          isNull(devicePairings.usedAt),
          gt(devicePairings.expiresAt, sql`now()`),
        ),
      )
      .returning();
    if (!pairing) throw invalidPairing();
    const [d] = await tx
      .insert(workerDevices)
      .values({
        organizationId: found.orgId,
        branchId: pairing.branchId,
        name: pairing.name,
        deviceSecretHash: hashToken(secret),
        authorizedBy: pairing.createdBy,
        lastSeenAt: new Date(),
      })
      .returning({ id: workerDevices.id, name: workerDevices.name });
    await tx.update(devicePairings).set({ deviceId: d!.id }).where(eq(devicePairings.id, pairing.id));
    await tx.insert(auditLogs).values({
      organizationId: found.orgId,
      actorType: 'owner',
      actorId: pairing.createdBy,
      action: 'device.authorized',
      entityType: 'worker_device',
      entityId: d!.id,
      after: { name: pairing.name, branchId: pairing.branchId, pairingId: pairing.id },
    });
    return d!;
  });
  return { secret, device };
}

export interface DeviceContext {
  deviceId: string;
  orgId: string;
  branchId: string;
  deviceName: string;
  orgName: string;
  branchName: string;
}

/** Resuelve el dispositivo por el secreto de su cookie. null si no existe, fue revocado o el negocio no está activo. */
export async function resolveDevice(db: Db, secret: string | undefined): Promise<DeviceContext | null> {
  if (!isToken(secret)) return null;
  // Transacción de sistema acotada al hash de un secreto de 128 bits: no admite búsquedas por otros datos.
  const [row] = await withSystemTx(db, (tx) =>
    tx
      .select({
        deviceId: workerDevices.id,
        orgId: workerDevices.organizationId,
        branchId: workerDevices.branchId,
        deviceName: workerDevices.name,
        orgName: organizations.name,
        branchName: branches.name,
        lastSeenAt: workerDevices.lastSeenAt,
      })
      .from(workerDevices)
      .innerJoin(organizations, eq(organizations.id, workerDevices.organizationId))
      .innerJoin(branches, eq(branches.id, workerDevices.branchId))
      .where(
        and(
          eq(workerDevices.deviceSecretHash, hashToken(secret)),
          isNull(workerDevices.revokedAt),
          eq(organizations.status, 'live'),
          eq(branches.status, 'active'),
        ),
      ),
  );
  if (!row) return null;
  if (!row.lastSeenAt || Date.now() - row.lastSeenAt.getTime() > LAST_SEEN_EVERY_MS)
    await withTenantTx(db, row.orgId, (tx) =>
      tx.update(workerDevices).set({ lastSeenAt: new Date() }).where(eq(workerDevices.id, row.deviceId)),
    );
  const { lastSeenAt: _l, ...ctx } = row;
  return ctx;
}

export async function listDevices(db: Db, orgId: string) {
  return withTenantTx(db, orgId, async (tx) => {
    const devices = await tx
      .select({
        id: workerDevices.id,
        name: workerDevices.name,
        branchId: workerDevices.branchId,
        branch: branches.name,
        createdAt: workerDevices.createdAt,
        lastSeenAt: workerDevices.lastSeenAt,
        revokedAt: workerDevices.revokedAt,
      })
      .from(workerDevices)
      .innerJoin(branches, eq(branches.id, workerDevices.branchId))
      .where(eq(workerDevices.organizationId, orgId))
      .orderBy(sql`${workerDevices.revokedAt} is not null`, desc(workerDevices.createdAt));
    const shifts = await tx
      .select({
        deviceId: staffSessions.deviceId,
        name: organizationUsers.displayName,
        since: staffSessions.createdAt,
      })
      .from(staffSessions)
      .innerJoin(organizationUsers, eq(organizationUsers.id, staffSessions.organizationUserId))
      .where(
        and(
          eq(staffSessions.organizationId, orgId),
          isNull(staffSessions.revokedAt),
          gt(staffSessions.expiresAt, sql`now()`),
        ),
      );
    return devices.map((d) => ({
      ...d,
      shift: shifts.find((s) => s.deviceId === d.id) ?? null,
    }));
  });
}

/** Revoca un dispositivo: su cookie deja de servir y se cierran sus turnos abiertos. */
export async function revokeDevice(db: Db, orgId: string, manager: Manager, deviceId: string) {
  await withTenantTx(db, orgId, async (tx) => {
    const [d] = await tx
      .update(workerDevices)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(workerDevices.id, deviceId),
          eq(workerDevices.organizationId, orgId),
          isNull(workerDevices.revokedAt),
        ),
      )
      .returning({ id: workerDevices.id, name: workerDevices.name });
    if (!d) throw notFound();
    await tx
      .update(staffSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(staffSessions.deviceId, deviceId), isNull(staffSessions.revokedAt)));
    await tx.insert(auditLogs).values({
      organizationId: orgId,
      actorType: manager.actorType,
      actorId: manager.orgUserId,
      action: 'device.revoked',
      entityType: 'worker_device',
      entityId: deviceId,
      after: { name: d.name },
    });
  });
}
