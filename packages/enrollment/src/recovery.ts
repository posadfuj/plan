/**
 * Recuperación de la tarjeta web. Nunca crea membresías: siempre devuelve la existente, con una URL
 * NUEVA (el token se rota): la URL anterior deja de funcionar en cualquier otro dispositivo.
 *
 *  1. Por correo: el cliente escribe su correo o su celular; si hay coincidencia y el cliente tiene
 *     correo registrado, se envía un enlace de un solo uso (30 min) a ESE correo. La respuesta es
 *     siempre la misma, exista o no, para no revelar quién es cliente.
 *  2. En caja: el dueño/admin o el trabajador (dispositivo + PIN) verifica a la persona y muestra
 *     un QR de un solo uso (10 min). Queda auditado.
 *
 * Buscar solo por celular no basta para abrir una tarjeta: el celular no es secreto.
 */
import { normalizePhone } from '@aiment/core';
import { schema, withSystemTx, withTenantTx, type Db } from '@aiment/db';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import QRCode from 'qrcode';
import { EnrollmentError, invalidRecovery, notFound } from './errors';
import type { PublicDeps } from './public';
import { hashToken, isToken, newToken } from './tokens';

const { cardRecoveryTokens, memberships, customers, organizations, shortLinks, auditLogs } = schema;

export const EMAIL_RECOVERY_MINUTES = 30;
export const IN_STORE_RECOVERY_MINUTES = 10;
export const MAX_EMAIL_RECOVERIES_PER_HOUR = 3;

export const NEUTRAL_RECOVERY_MESSAGE =
  'Si los datos coinciden con una tarjeta que tenga correo registrado, te enviamos un enlace. Revisa tu bandeja (y spam). Si no registraste correo, pide tu tarjeta en caja.';

const firstName = (full: string | null) => (full ?? '').trim().split(/\s+/)[0] || 'Hola';

/** Envía (si corresponde) el correo de recuperación. Se usa en la recuperación y al detectar un registro duplicado. */
export async function requestEmailRecoveryForMembership(
  deps: PublicDeps,
  orgId: string,
  membershipId: string,
): Promise<boolean> {
  const issued = await withTenantTx(deps.db, orgId, async (tx) => {
    const [m] = await tx
      .select({ email: customers.email, name: customers.fullName, orgName: organizations.name })
      .from(memberships)
      .innerJoin(customers, eq(customers.id, memberships.customerId))
      .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
      .where(
        and(
          eq(memberships.id, membershipId),
          eq(memberships.organizationId, orgId),
          eq(memberships.status, 'active'),
        ),
      );
    if (!m?.email) return null;
    const [{ recent }] = (await tx
      .select({ recent: sql<number>`count(*)::int` })
      .from(cardRecoveryTokens)
      .where(
        and(
          eq(cardRecoveryTokens.membershipId, membershipId),
          eq(cardRecoveryTokens.channel, 'email'),
          sql`${cardRecoveryTokens.createdAt} > now() - interval '1 hour'`,
        ),
      )) as [{ recent: number }];
    if (recent >= MAX_EMAIL_RECOVERIES_PER_HOUR) return null;
    const token = newToken();
    await tx.insert(cardRecoveryTokens).values({
      organizationId: orgId,
      membershipId,
      tokenHash: hashToken(token),
      channel: 'email',
      expiresAt: new Date(Date.now() + EMAIL_RECOVERY_MINUTES * 60_000),
    });
    return { token, ...m, email: m.email };
  });
  if (!issued) return false;

  const url = `${deps.publicBaseUrl.replace(/\/$/, '')}/r/${issued.token}`;
  // El envío no se espera: la respuesta tarda lo mismo haya o no correo (no revela si existe el cliente).
  void deps.mailer
    .send({
      to: issued.email,
      subject: `Tu tarjeta de ${issued.orgName}`,
      text: [
        `${firstName(issued.name)}, este es el enlace para abrir tu tarjeta de ${issued.orgName}:`,
        '',
        url,
        '',
        `Vence en ${EMAIL_RECOVERY_MINUTES} minutos y solo se puede usar una vez.`,
        'Si no lo pediste, ignora este correo: tu tarjeta sigue segura.',
        '',
        '— Powered by Aiment Wallet',
      ].join('\n'),
    })
    .catch((err) =>
      deps.log?.(`[mail] no se pudo enviar la recuperación: ${err instanceof Error ? err.message : err}`),
    );
  return true;
}

/** Recuperación pública por correo o celular (respuesta siempre neutra). */
export async function requestEmailRecovery(
  deps: PublicDeps,
  input: { code: string; contact: string },
): Promise<{ message: string }> {
  const neutral = { message: NEUTRAL_RECOVERY_MESSAGE };
  const contact = (input.contact ?? '').trim();
  if (!contact || contact.length > 120)
    throw new EnrollmentError(422, 'invalid_contact', 'Escribe tu correo o tu celular');
  const slug = (input.code ?? '').toUpperCase();

  const [link] = await withSystemTx(deps.db, (tx) =>
    tx
      .select({ orgId: shortLinks.organizationId })
      .from(shortLinks)
      .innerJoin(organizations, eq(organizations.id, shortLinks.organizationId))
      .where(
        and(eq(shortLinks.slug, slug), eq(shortLinks.status, 'active'), eq(organizations.status, 'live')),
      ),
  );
  if (!link) throw notFound();

  const isEmail = contact.includes('@');
  const phone = isEmail ? null : normalizePhone(contact);
  if (!isEmail && !phone)
    throw new EnrollmentError(422, 'invalid_contact', 'Escribe un correo o un celular válido');

  const [m] = await withTenantTx(deps.db, link.orgId, (tx) =>
    tx
      .select({ membershipId: memberships.id })
      .from(customers)
      .innerJoin(memberships, eq(memberships.customerId, customers.id))
      .where(
        and(
          eq(customers.organizationId, link.orgId),
          eq(customers.status, 'active'),
          isEmail ? eq(customers.email, contact.toLowerCase()) : eq(customers.phoneE164, phone!),
        ),
      )
      .limit(1),
  );
  if (m) await requestEmailRecoveryForMembership(deps, link.orgId, m.membershipId);
  return neutral;
}

/** Recuperación en caja: la persona se identifica en el local y escanea un QR de un solo uso. */
export async function issueInStoreRecovery(
  deps: PublicDeps,
  orgId: string,
  membershipId: string,
  operator: { orgUserId: string; actorType: 'owner' | 'staff'; deviceId?: string | null },
) {
  const token = newToken();
  const expiresAt = new Date(Date.now() + IN_STORE_RECOVERY_MINUTES * 60_000);
  await withTenantTx(deps.db, orgId, async (tx) => {
    const [m] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.id, membershipId),
          eq(memberships.organizationId, orgId),
          eq(memberships.status, 'active'),
        ),
      );
    if (!m) throw notFound();
    const [row] = await tx
      .insert(cardRecoveryTokens)
      .values({
        organizationId: orgId,
        membershipId,
        tokenHash: hashToken(token),
        channel: 'in_store',
        issuedBy: operator.orgUserId,
        expiresAt,
      })
      .returning({ id: cardRecoveryTokens.id });
    await tx.insert(auditLogs).values({
      organizationId: orgId,
      actorType: operator.actorType,
      actorId: operator.orgUserId,
      action: 'card.recovery_issued',
      entityType: 'membership',
      entityId: membershipId,
      after: {
        channel: 'in_store',
        recoveryId: row!.id,
        expiresAt: expiresAt.toISOString(),
        ...(operator.deviceId ? { deviceId: operator.deviceId } : {}),
      },
    });
  });
  const recoveryUrl = `${deps.publicBaseUrl.replace(/\/$/, '')}/r/${token}`;
  return {
    recoveryUrl,
    expiresAt,
    qrSvg: await QRCode.toString(recoveryUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }),
  };
}

/**
 * Canjea un enlace de recuperación (un solo uso) y devuelve la tarjeta EXISTENTE con un token nuevo.
 * En la base solo queda el hash del token nuevo; el anterior deja de abrir la tarjeta.
 */
export async function redeemRecovery(db: Db, token: string): Promise<{ webCardToken: string }> {
  if (!isToken(token)) throw invalidRecovery();
  const tokenHash = hashToken(token);
  const [found] = await withSystemTx(db, (tx) =>
    tx
      .select({ id: cardRecoveryTokens.id, orgId: cardRecoveryTokens.organizationId })
      .from(cardRecoveryTokens)
      .where(eq(cardRecoveryTokens.tokenHash, tokenHash)),
  );
  if (!found) throw invalidRecovery();

  return withTenantTx(db, found.orgId, async (tx) => {
    // Marcar como usado de forma atómica: dos aperturas simultáneas → solo una gana.
    const [used] = await tx
      .update(cardRecoveryTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(cardRecoveryTokens.id, found.id),
          isNull(cardRecoveryTokens.usedAt),
          gt(cardRecoveryTokens.expiresAt, sql`now()`),
        ),
      )
      .returning({ membershipId: cardRecoveryTokens.membershipId, channel: cardRecoveryTokens.channel });
    if (!used) throw invalidRecovery();
    const webCardToken = newToken();
    const [m] = await tx
      .update(memberships)
      .set({ webCardTokenHash: hashToken(webCardToken) })
      .where(and(eq(memberships.id, used.membershipId), eq(memberships.status, 'active')))
      .returning({ id: memberships.id });
    if (!m) throw invalidRecovery();
    await tx.insert(auditLogs).values({
      organizationId: found.orgId,
      actorType: 'system',
      action: 'card.recovered',
      entityType: 'membership',
      entityId: used.membershipId,
      after: { channel: used.channel, cardTokenRotated: true },
    });
    return { webCardToken };
  });
}
