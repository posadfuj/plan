/**
 * Sucursales. Cada una tiene su enlace de registro (QR y NFC del mostrador) y sus dispositivos de caja.
 * El tope de sucursales activas lo pone el plan. Todas comparten el mismo programa (reglas distintas
 * por sucursal están fuera del MVP).
 */
import { schema, withTenantTx, type Db, type Tx } from '@aiment/db';
import { isUniqueViolation, newShortCode, printedUrls } from '@aiment/enrollment';
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { BusinessError, notFound, type Editor } from './errors';
import { assertWithinPlan } from './limits';

const { branches, shortLinks, staffSessions, auditLogs } = schema;

export const branchInput = z
  .object({
    name: z
      .string()
      .trim()
      .transform((s) => s.replace(/\s+/g, ' '))
      .pipe(z.string().min(2, 'Escribe el nombre de la sucursal').max(60, 'Máximo 60 caracteres')),
    address: z
      .string()
      .trim()
      .max(160, 'Máximo 160 caracteres')
      .transform((s) => s || null)
      .nullish(),
  })
  .strict();

export async function listBranches(db: Db, orgId: string, publicBaseUrl: string) {
  const rows = await withTenantTx(db, orgId, (tx) =>
    tx
      .select({
        id: branches.id,
        name: branches.name,
        address: branches.address,
        status: branches.status,
        linkId: shortLinks.id,
        slug: shortLinks.slug,
        devices: sql<number>`(select count(*)::int from app.worker_devices d where d.branch_id = ${branches.id} and d.revoked_at is null)`,
      })
      .from(branches)
      .leftJoin(shortLinks, and(eq(shortLinks.branchId, branches.id), eq(shortLinks.kind, 'registration')))
      .where(eq(branches.organizationId, orgId))
      .orderBy(sql`${branches.status} <> 'active'`, asc(branches.createdAt)),
  );
  return rows.map((r) => ({
    ...r,
    ...(r.slug ? printedUrls(publicBaseUrl, r.slug) : { qrUrl: null, nfcUrl: null }),
  }));
}

async function createLink(tx: Tx, orgId: string, branchId: string) {
  // El código se imprime en el QR y se graba en el NFC: 6 caracteres sin ambiguos. Reintenta si choca.
  for (let i = 0; i < 5; i++) {
    const slug = newShortCode(6);
    try {
      await tx.execute(sql`savepoint new_link`);
      await tx.insert(shortLinks).values({
        slug,
        organizationId: orgId,
        branchId,
        kind: 'registration',
        target: `/join/${slug}`,
      });
      await tx.execute(sql`release savepoint new_link`);
      return slug;
    } catch (err) {
      await tx.execute(sql`rollback to savepoint new_link`);
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new Error('No se pudo generar un código de enlace único');
}

export async function createBranch(db: Db, orgId: string, editor: Editor, raw: unknown) {
  const input = branchInput.parse(raw);
  return withTenantTx(db, orgId, async (tx) => {
    await assertWithinPlan(tx, orgId, 'branches');
    await assertUniqueName(tx, orgId, input.name);
    const [b] = await tx
      .insert(branches)
      .values({ organizationId: orgId, name: input.name, address: input.address ?? null })
      .returning({ id: branches.id, name: branches.name });
    const slug = await createLink(tx, orgId, b!.id);
    await tx.insert(auditLogs).values({
      organizationId: orgId,
      actorType: editor.actorType,
      actorId: editor.orgUserId,
      action: 'branch.created',
      entityType: 'branch',
      entityId: b!.id,
      after: { name: b!.name, slug },
    });
    return { id: b!.id, name: b!.name, slug };
  });
}

async function assertUniqueName(tx: Tx, orgId: string, name: string, exceptId?: string) {
  const [dup] = await tx
    .select({ id: branches.id })
    .from(branches)
    .where(
      and(
        eq(branches.organizationId, orgId),
        sql`lower(${branches.name}) = lower(${name})`,
        exceptId ? ne(branches.id, exceptId) : undefined,
      ),
    );
  if (dup) throw new BusinessError(409, 'name_taken', 'Ya hay una sucursal con ese nombre');
}

export async function updateBranch(db: Db, orgId: string, editor: Editor, branchId: string, raw: unknown) {
  const input = branchInput.parse(raw);
  return withTenantTx(db, orgId, async (tx) => {
    const [cur] = await tx
      .select()
      .from(branches)
      .where(and(eq(branches.id, branchId), eq(branches.organizationId, orgId)))
      .for('update');
    if (!cur) throw notFound();
    await assertUniqueName(tx, orgId, input.name, branchId);
    await tx
      .update(branches)
      .set({ name: input.name, address: input.address ?? null })
      .where(eq(branches.id, branchId));
    await tx.insert(auditLogs).values({
      organizationId: orgId,
      actorType: editor.actorType,
      actorId: editor.orgUserId,
      action: 'branch.updated',
      entityType: 'branch',
      entityId: branchId,
      before: { name: cur.name, address: cur.address },
      after: { name: input.name, address: input.address ?? null },
    });
    return { id: branchId, name: input.name };
  });
}

/**
 * Desactivar: su QR/NFC deja de registrar clientes, sus cajas dejan de funcionar y se cierran sus
 * turnos. No se borra nada; se puede reactivar (si el plan lo permite). Siempre queda una activa.
 */
export async function setBranchActive(
  db: Db,
  orgId: string,
  editor: Editor,
  branchId: string,
  active: boolean,
) {
  return withTenantTx(db, orgId, async (tx) => {
    const [cur] = await tx
      .select()
      .from(branches)
      .where(and(eq(branches.id, branchId), eq(branches.organizationId, orgId)))
      .for('update');
    if (!cur) throw notFound();
    const status = active ? 'active' : 'inactive';
    if (cur.status === status)
      throw new BusinessError(
        409,
        'no_change',
        active ? 'La sucursal ya está activa' : 'La sucursal ya está desactivada',
      );
    if (active) await assertWithinPlan(tx, orgId, 'branches');
    else {
      const [{ n }] = (await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(branches)
        .where(and(eq(branches.organizationId, orgId), eq(branches.status, 'active')))) as [{ n: number }];
      if (n <= 1)
        throw new BusinessError(409, 'last_branch', 'El negocio necesita al menos una sucursal activa');
    }
    await tx.update(branches).set({ status }).where(eq(branches.id, branchId));
    await tx
      .update(shortLinks)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(shortLinks.branchId, branchId), eq(shortLinks.organizationId, orgId)));
    if (!active)
      await tx
        .update(staffSessions)
        .set({ revokedAt: new Date() })
        .where(
          and(
            isNull(staffSessions.revokedAt),
            sql`${staffSessions.deviceId} in (select id from app.worker_devices where branch_id = ${branchId})`,
          ),
        );
    await tx.insert(auditLogs).values({
      organizationId: orgId,
      actorType: editor.actorType,
      actorId: editor.orgUserId,
      action: active ? 'branch.reactivated' : 'branch.deactivated',
      entityType: 'branch',
      entityId: branchId,
      after: { name: cur.name },
    });
    return { id: branchId, status };
  });
}

/** Valida que las sucursales pertenezcan al negocio y estén activas (restricción de trabajador). */
export async function assertBranchIds(tx: Tx, orgId: string, ids: string[]) {
  if (!ids.length) return;
  const rows = await tx
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.organizationId, orgId), eq(branches.status, 'active')));
  const ok = new Set(rows.map((r) => r.id));
  if (!ids.every((id) => ok.has(id)))
    throw new BusinessError(422, 'invalid_branch', 'Elige sucursales activas del negocio');
}
