/**
 * Rutas públicas del cliente final (sin sesión). Se accede por código de sucursal o por tokens.
 * Límites: uno holgado por IP (varios clientes pueden compartirla) y otro por celular/contacto
 * dentro del negocio. Las respuestas con datos personales no se cachean.
 */
import {
  EnrollmentError,
  findCardMembershipId,
  getCard,
  getJoinInfo,
  getScanInfo,
  parseChannel,
  redeemRecovery,
  registerCustomer,
  requestEmailRecovery,
  resolveShortLink,
  visitorHash,
} from '@aiment/enrollment';
import { normalizePhone } from '@aiment/core';
import { requestWalletLink } from '@aiment/wallet';
import { Hono } from 'hono';
import type { AppEnv } from '../context';
import { clientIp, jsonBody as json, limit, privateHeaders, TEN_MIN } from '../request';

/** Clave por negocio + celular/correo: el límite fino no depende de la IP (compartida en un local o por CGNAT). */
function contactKey(code: unknown, contact: unknown): string {
  const raw = String(contact ?? '')
    .trim()
    .toLowerCase();
  return `${String(code ?? '').toUpperCase()}:${normalizePhone(raw) ?? raw.slice(0, 120)}`;
}

/** QR/NFC del mostrador: registra la visita y redirige a la landing (ruta relativa: mismo dominio). */
export const goRoutes = new Hono<AppEnv>().get('/:slug', async (c) => {
  limit(c, 'publicRead', 60_000);
  const channel = parseChannel(c.req.query('c'));
  const salt = c.var.deps.config.visitorSalt ?? 'dev-salt';
  const r = await resolveShortLink(c.var.deps.db, c.req.param('slug'), {
    channel,
    visitorHash: visitorHash(clientIp(c), c.req.header('user-agent') ?? '', salt),
  });
  if (!r) return c.redirect('/enlace-no-disponible', 302);
  const sep = r.target.includes('?') ? '&' : '?';
  c.header('Cache-Control', 'no-store');
  return c.redirect(`${r.target}${sep}c=${channel}&v=${r.visitId}`, 302);
});

export const publicRoutes = new Hono<AppEnv>()
  // Logos del negocio (clave aleatoria por subida → se pueden cachear para siempre).
  .get('/files/:folder/:org/:file', async (c) => {
    const { folder, org, file } = c.req.param();
    const obj = await c.var.deps.storage.get(`${folder}/${org}/${file}`);
    if (!obj) return c.json({ error: { code: 'not_found', message: 'Archivo no encontrado' } }, 404);
    c.header('Content-Type', obj.contentType);
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Security-Policy', "default-src 'none'; img-src 'self'");
    c.header('Cross-Origin-Resource-Policy', 'same-site');
    return c.body(new Uint8Array(obj.bytes));
  })

  .get('/join/:code', async (c) => {
    limit(c, 'publicRead', 60_000);
    return c.json(await getJoinInfo(c.var.deps.db, c.req.param('code')));
  })

  .post('/register', async (c) => {
    limit(c, 'register', TEN_MIN);
    const body = await json(c);
    limit(c, 'registerPhone', TEN_MIN, contactKey(body.code, body.phone));
    const result = await registerCustomer(
      { db: c.var.deps.db, mailer: c.var.deps.mailer, publicBaseUrl: c.var.deps.publicBaseUrl },
      body,
      { ip: clientIp(c), userAgent: c.req.header('user-agent') ?? null },
    );
    privateHeaders(c);
    return c.json(result, result.status === 'created' ? 201 : 200);
  })

  .get('/cards/:token', async (c) => {
    limit(c, 'publicRead', 60_000);
    privateHeaders(c);
    return c.json(
      await getCard(c.var.deps.db, c.req.param('token'), { googleWallet: !!c.var.deps.googleWallet }),
    );
  })

  /**
   * Enlace "Guardar en Google Wallet" de la tarjeta. Se arma en el servidor (firma con la cuenta
   * del emisor) sin llamar a Google: funciona aunque la API de Google esté caída.
   */
  .post('/cards/:token/wallet/google', async (c) => {
    limit(c, 'publicRead', 60_000);
    const token = c.req.param('token');
    const { db, googleWallet, publicBaseUrl } = c.var.deps;
    if (!googleWallet)
      throw new EnrollmentError(404, 'wallet_unavailable', 'Google Wallet todavía no está disponible.');
    const membershipId = await findCardMembershipId(db, token);
    limit(c, 'walletLink', TEN_MIN, membershipId);
    const r = await requestWalletLink(db, googleWallet, membershipId, publicBaseUrl);
    privateHeaders(c);
    if (r.status === 'blocked')
      throw new EnrollmentError(
        409,
        'card_blocked',
        'Tu tarjeta está pausada por el negocio. Consulta en el local.',
      );
    if (r.status === 'not_found') throw new EnrollmentError(404, 'not_found', 'No encontramos lo que buscas');
    return c.json({ url: r.addUrl });
  })

  .get('/scan/:token', async (c) => {
    limit(c, 'publicRead', 60_000);
    privateHeaders(c);
    return c.json(await getScanInfo(c.var.deps.db, c.req.param('token')));
  })

  .post('/recovery', async (c) => {
    limit(c, 'recovery', TEN_MIN);
    const b = await json(c);
    limit(c, 'recoveryContact', TEN_MIN, contactKey(b.code, b.contact));
    const out = await requestEmailRecovery(
      { db: c.var.deps.db, mailer: c.var.deps.mailer, publicBaseUrl: c.var.deps.publicBaseUrl },
      { code: String(b.code ?? ''), contact: String(b.contact ?? '') },
    );
    return c.json(out, 202);
  })

  .post('/recovery/redeem', async (c) => {
    limit(c, 'redeem', TEN_MIN);
    const b = await json(c);
    privateHeaders(c);
    return c.json(await redeemRecovery(c.var.deps.db, String(b.token ?? '')));
  });
