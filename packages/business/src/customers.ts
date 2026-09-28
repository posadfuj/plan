/**
 * Clientes desde el panel: lista con búsqueda, ficha, bloqueo, invalidar la URL de la tarjeta y baja
 * (anonimización). Sumar, canjear, ajustar y anular usan @aiment/ledger (mismo servicio que la caja).
 */
import { schema, withTenantTx, type Db, type Tx } from '@aiment/db';
import { maskPhone, normalizePhone } from '@aiment/core';
import { CUSTOMER_NAME_RE, hashToken, newToken } from '@aiment/enrollment';
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { BusinessError, notFound, type Editor } from './errors';

const {
  customers,
  memberships,
  ledgerEntries,
  earnedRewards,
  rewards,
  redemptions,
  organizationUsers,
  customerConsents,
  consentVersions,
  cardRecoveryTokens,
  walletPasses,
  auditLogs,
  eventOutbox,
} = schema;

export const listCustomersQuery = z.object({
  q: z.string().trim().max(60).optional(),
  status: z.enum(['all', 'active', 'blocked']).default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export async function listCustomers(db: Db, orgId: string, raw: unknown) {
  const { q, status, limit, offset } = listCustomersQuery.parse(raw ?? {});
  const text = q ?? '';
  const digits = text.replace(/\D/g, '');
  const code = text.toUpperCase().replace(/\s/g, '');
  const search = text
    ? or(
        ilike(customers.fullName, `%${text.replace(/[%_\\]/g, '')}%`),
        digits.length >= 3 ? ilike(customers.phoneE164, `%${digits}%`) : undefined,
        /^[2-9A-Z]{6}$/.test(code) ? eq(memberships.shortCode, code) : undefined,
        text.includes('@') ? eq(customers.email, text.toLowerCase()) : undefined,
      )
    : undefined;
  const where = and(
    eq(customers.organizationId, orgId),
    eq(customers.status, 'active'),
    status === 'all' ? undefined : eq(memberships.status, status),
    search,
  );
  return withTenantTx(db, orgId, async (tx) => {
    const rows = await tx
      .select({
        id: customers.id,
        fullName: customers.fullName,
        phone: customers.phoneE164,
        membershipId: memberships.id,
        status: memberships.status,
        shortCode: memberships.shortCode,
        balance: memberships.balance,
        lastActivityAt: memberships.lastActivityAt,
        createdAt: customers.createdAt,
      })
      .from(customers)
      .innerJoin(memberships, eq(memberships.customerId, customers.id))
      .where(where)
      .orderBy(sql`${memberships.lastActivityAt} desc nulls last`, desc(customers.createdAt))
      .limit(limit)
      .offset(offset);
    const [{ total }] = (await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(customers)
      .innerJoin(memberships, eq(memberships.customerId, customers.id))
      .where(where)) as [{ total: number }];
    return { customers: rows, total, limit, offset };
  });
}

export async function getCustomer(db: Db, orgId: string, customerId: string) {
  return withTenantTx(db, orgId, async (tx) => {
    const [customer] = await tx
      .select({
        id: customers.id,
        fullName: customers.fullName,
        phone: customers.phoneE164,
        email: customers.email,
        birthDate: customers.birthDate,
        status: customers.status,
        createdAt: customers.createdAt,
      })
      .from(customers)
      .where(
        and(
          eq(customers.id, customerId),
          eq(customers.organizationId, orgId),
          eq(customers.status, 'active'),
        ),
      );
    if (!customer) throw notFound();
    const [membership] = await tx
      .select({
        id: memberships.id,
        status: memberships.status,
        balance: memberships.balance,
        lifetimeEarned: memberships.lifetimeEarned,
        shortCode: memberships.shortCode,
        firstValidatedAt: memberships.firstValidatedAt,
        lastActivityAt: memberships.lastActivityAt,
      })
      .from(memberships)
      .where(and(eq(memberships.customerId, customerId), eq(memberships.organizationId, orgId)));
    const [marketing] = await tx
      .select({ granted: customerConsents.granted })
      .from(customerConsents)
      .innerJoin(consentVersions, eq(consentVersions.id, customerConsents.consentVersionId))
      .where(and(eq(customerConsents.customerId, customerId), eq(consentVersions.kind, 'marketing')))
      .orderBy(desc(customerConsents.createdAt))
      .limit(1);
    if (!membership)
      return {
        customer,
        marketing: marketing?.granted ?? false,
        membership: null,
        rewards: [],
        movements: [],
      };

    const available = await tx
      .select({ id: earnedRewards.id, name: rewards.name, expiresAt: earnedRewards.expiresAt })
      .from(earnedRewards)
      .innerJoin(rewards, eq(rewards.id, earnedRewards.rewardId))
      .where(and(eq(earnedRewards.membershipId, membership.id), eq(earnedRewards.status, 'available')))
      .orderBy(asc(earnedRewards.createdAt));
    const movements = await tx
      .select({
        id: ledgerEntries.id,
        kind: ledgerEntries.kind,
        delta: ledgerEntries.delta,
        balanceAfter: ledgerEntries.balanceAfter,
        reason: ledgerEntries.reason,
        by: organizationUsers.displayName,
        actorType: ledgerEntries.actorType,
        createdAt: ledgerEntries.createdAt,
        reversesEntryId: ledgerEntries.reversesEntryId,
        reversed: sql<boolean>`exists (select 1 from app.ledger_entries r where r.reverses_entry_id = ${ledgerEntries.id})`,
      })
      .from(ledgerEntries)
      .leftJoin(organizationUsers, eq(organizationUsers.id, ledgerEntries.actorId))
      .where(and(eq(ledgerEntries.membershipId, membership.id), eq(ledgerEntries.organizationId, orgId)))
      .orderBy(desc(ledgerEntries.createdAt))
      .limit(30);
    const rewardRedemptions = await tx
      .select({
        id: redemptions.id,
        reward: rewards.name,
        status: redemptions.status,
        by: organizationUsers.displayName,
        createdAt: redemptions.createdAt,
      })
      .from(redemptions)
      .innerJoin(rewards, eq(rewards.id, redemptions.rewardId))
      .leftJoin(organizationUsers, eq(organizationUsers.id, redemptions.organizationUserId))
      .where(eq(redemptions.membershipId, membership.id))
      .orderBy(desc(redemptions.createdAt))
      .limit(10);
    return {
      customer,
      marketing: marketing?.granted ?? false,
      membership,
      rewards: available,
      movements: movements.map((m) => ({
        ...m,
        // Sumas y ajustes se anulan desde aquí; los canjes, desde la lista de canjes.
        canVoid: ['earn', 'adjust'].includes(m.kind) && !m.reversed,
      })),
      redemptions: rewardRedemptions.map((r) => ({ ...r, canVoid: r.status === 'completed' })),
    };
  });
}

const reasonSchema = z.string().trim().min(3, 'Indica el motivo').max(300);

async function membershipOf(tx: Tx, orgId: string, id: string) {
  const [m] = await tx
    .select({ id: memberships.id, status: memberships.status, customerId: memberships.customerId })
    .from(memberships)
    .where(and(eq(memberships.id, id), eq(memberships.organizationId, orgId)))
    .for('update');
  // Un cliente dado de baja (anonimizado) ya no se gestiona.
  if (!m || m.status === 'closed') throw notFound();
  return m;
}

/**
 * Bloquear: la caja no puede sumar ni canjear y la tarjeta muestra "consulta en el local" sin QR.
 * El saldo y el historial no cambian. Se desbloquea igual de fácil.
 */
export async function setMembershipBlocked(
  db: Db,
  orgId: string,
  editor: Editor,
  membershipId: string,
  blocked: boolean,
  rawReason: unknown,
) {
  const reason = blocked
    ? reasonSchema.parse(rawReason)
    : (typeof rawReason === 'string' ? rawReason.trim().slice(0, 300) : '') || null;
  return withTenantTx(db, orgId, async (tx) => {
    const m = await membershipOf(tx, orgId, membershipId);
    const status = blocked ? 'blocked' : 'active';
    if (m.status === 'closed') throw notFound();
    if (m.status === status)
      throw new BusinessError(
        409,
        'no_change',
        blocked ? 'El cliente ya está bloqueado' : 'El cliente no está bloqueado',
      );
    await tx
      .update(memberships)
      .set({ status, version: sql`${memberships.version} + 1` })
      .where(eq(memberships.id, m.id));
    await tx.insert(auditLogs).values({
      organizationId: orgId,
      actorType: editor.actorType,
      actorId: editor.orgUserId,
      action: blocked ? 'membership.blocked' : 'membership.unblocked',
      entityType: 'membership',
      entityId: m.id,
      before: { status: m.status },
      after: { status, reason },
    });
    await tx.insert(eventOutbox).values({
      organizationId: orgId,
      type: 'membership.updated',
      aggregateId: m.id,
      payload: { status },
    });
    return { id: m.id, status };
  });
}

/**
 * Invalida la URL actual de la tarjeta (p. ej., el cliente perdió el celular o la compartió).
 * La nueva URL no se muestra a nadie: el cliente la obtiene con la recuperación (correo o QR en el local).
 */
export async function rotateCardUrl(db: Db, orgId: string, editor: Editor, membershipId: string) {
  return withTenantTx(db, orgId, async (tx) => {
    const m = await membershipOf(tx, orgId, membershipId);
    if (m.status === 'closed') throw notFound();
    await tx
      .update(memberships)
      .set({ webCardTokenHash: hashToken(newToken()) })
      .where(eq(memberships.id, m.id));
    await tx.insert(auditLogs).values({
      organizationId: orgId,
      actorType: editor.actorType,
      actorId: editor.orgUserId,
      action: 'card.url_rotated',
      entityType: 'membership',
      entityId: m.id,
      after: { by: 'panel' },
    });
    return { id: m.id, rotated: true };
  });
}

function isPhoneTaken(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 3 && e; i++) {
    const x = e as { code?: string; constraint_name?: string };
    if (x.code === '23505' && x.constraint_name === 'customers_org_phone') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

const phoneTaken = () =>
  new BusinessError(
    409,
    'phone_in_use',
    'Ese celular ya pertenece a otro cliente de este negocio. No se pueden unir tarjetas desde aquí.',
  );

/**
 * Corrige el nombre y/o el celular del cliente desde su ficha.
 * - Solo cambia los datos del cliente: la membresía, sus tokens, el saldo y el historial no se tocan.
 * - Motivo obligatorio y auditoría. La auditoría no se puede borrar, así que NO guarda el nombre ni el
 *   celular completos (quedarían después de una baja): guarda qué cambió y el celular enmascarado.
 * - Un celular que ya tiene otro cliente del negocio se rechaza (también si dos ediciones compiten).
 */
export async function updateCustomer(
  db: Db,
  orgId: string,
  editor: Editor,
  customerId: string,
  input: { fullName?: unknown; phone?: unknown; reason?: unknown },
) {
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length < 5 || reason.length > 300)
    throw new BusinessError(422, 'reason_required', 'Indica el motivo del cambio (mínimo 5 caracteres)');
  let fullName: string | undefined;
  if (input.fullName !== undefined) {
    fullName = String(input.fullName).trim().replace(/\s+/g, ' ');
    if (!CUSTOMER_NAME_RE.test(fullName))
      throw new BusinessError(422, 'invalid_name', 'Escribe el nombre con letras (2 a 80 caracteres)');
  }
  let phone: string | undefined;
  if (input.phone !== undefined) {
    phone = normalizePhone(String(input.phone)) ?? undefined;
    if (!phone)
      throw new BusinessError(422, 'invalid_phone', 'Escribe un celular válido (9 dígitos, empieza con 9)');
  }
  if (fullName === undefined && phone === undefined)
    throw new BusinessError(422, 'nothing_to_change', 'Indica el nombre o el celular a corregir');

  try {
    return await withTenantTx(db, orgId, async (tx) => {
      const [c] = await tx
        .select({ id: customers.id, fullName: customers.fullName, phone: customers.phoneE164 })
        .from(customers)
        .where(
          and(
            eq(customers.id, customerId),
            eq(customers.organizationId, orgId),
            eq(customers.status, 'active'),
          ),
        )
        .for('update');
      if (!c) throw notFound();
      const changes: { fullName?: string; phoneE164?: string } = {};
      if (fullName !== undefined && fullName !== c.fullName) changes.fullName = fullName;
      if (phone !== undefined && phone !== c.phone) changes.phoneE164 = phone;
      if (!Object.keys(changes).length) throw new BusinessError(409, 'no_change', 'Los datos ya son esos');

      if (changes.phoneE164) {
        const [other] = await tx
          .select({ id: customers.id })
          .from(customers)
          .where(
            and(
              eq(customers.organizationId, orgId),
              eq(customers.phoneE164, changes.phoneE164),
              eq(customers.status, 'active'),
            ),
          );
        if (other) throw phoneTaken();
      }

      await tx.update(customers).set(changes).where(eq(customers.id, c.id));
      const fields = [changes.fullName !== undefined && 'fullName', changes.phoneE164 && 'phone'].filter(
        Boolean,
      );
      await tx.insert(auditLogs).values({
        organizationId: orgId,
        actorType: editor.actorType,
        actorId: editor.orgUserId,
        action: 'customer.updated',
        entityType: 'customer',
        entityId: c.id,
        before: changes.phoneE164 && c.phone ? { phone: maskPhone(c.phone) } : null,
        after: { fields, reason, ...(changes.phoneE164 ? { phone: maskPhone(changes.phoneE164) } : {}) },
      });
      // El nombre se muestra en la tarjeta web y en los pases: se resincronizan.
      const ms = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.customerId, c.id), eq(memberships.organizationId, orgId)));
      for (const m of ms)
        await tx.insert(eventOutbox).values({
          organizationId: orgId,
          type: 'membership.updated',
          aggregateId: m.id,
          payload: { fields },
        });

      const [updated] = await tx
        .select({ id: customers.id, fullName: customers.fullName, phone: customers.phoneE164 })
        .from(customers)
        .where(eq(customers.id, c.id));
      return { customer: updated!, changed: fields };
    });
  } catch (err) {
    if (isPhoneTaken(err)) throw phoneTaken();
    throw err;
  }
}

/**
 * Baja del cliente (derecho de cancelación, Ley 29733): se borran sus datos personales y la tarjeta deja
 * de funcionar. El ledger se conserva (no tiene datos personales) para que los reportes cuadren.
 * Irreversible: se pide confirmar escribiendo BAJA.
 */
export async function anonymizeCustomer(
  db: Db,
  orgId: string,
  editor: Editor,
  customerId: string,
  input: { confirm?: unknown; reason?: unknown },
) {
  if (input.confirm !== 'BAJA')
    throw new BusinessError(
      422,
      'confirmation_required',
      'Escribe BAJA para confirmar: no se puede deshacer',
    );
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 300) || null : null;
  return withTenantTx(db, orgId, async (tx) => {
    const [c] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(
        and(
          eq(customers.id, customerId),
          eq(customers.organizationId, orgId),
          eq(customers.status, 'active'),
        ),
      )
      .for('update');
    if (!c) throw notFound();
    const now = new Date();
    await tx
      .update(customers)
      .set({
        status: 'anonymized',
        anonymizedAt: now,
        fullName: null,
        phoneE164: null,
        email: null,
        birthDate: null,
      })
      .where(eq(customers.id, c.id));
    // Evidencia de consentimiento sin datos del dispositivo.
    await tx
      .update(customerConsents)
      .set({ ip: null, userAgent: null })
      .where(eq(customerConsents.customerId, c.id));
    const ms = await tx
      .update(memberships)
      .set({
        status: 'closed',
        // Tokens nuevos que nadie conoce: el QR y la URL anteriores dejan de funcionar.
        memberScanToken: newToken(),
        webCardTokenHash: hashToken(newToken()),
        version: sql`${memberships.version} + 1`,
      })
      .where(and(eq(memberships.customerId, c.id), eq(memberships.organizationId, orgId)))
      .returning({ id: memberships.id });
    const ids = ms.map((m) => m.id);
    if (ids.length) {
      await tx
        .update(cardRecoveryTokens)
        .set({ usedAt: now })
        .where(and(inArray(cardRecoveryTokens.membershipId, ids), isNull(cardRecoveryTokens.usedAt)));
      await tx
        .update(walletPasses)
        .set({ status: 'revoked', updatedAt: now })
        .where(and(inArray(walletPasses.membershipId, ids), eq(walletPasses.status, 'active')));
      for (const id of ids)
        await tx
          .insert(eventOutbox)
          .values({ organizationId: orgId, type: 'membership.closed', aggregateId: id });
    }
    await tx.insert(auditLogs).values({
      organizationId: orgId,
      actorType: editor.actorType,
      actorId: editor.orgUserId,
      action: 'customer.anonymized',
      entityType: 'customer',
      entityId: c.id,
      after: { memberships: ids.length, reason },
    });
    return { id: c.id, anonymized: true };
  });
}
