/**
 * Rutas públicas del cliente final (sin sesión). Se accede por código de sucursal o por tokens.
 * Límites: uno holgado por IP (varios clientes pueden compartirla) y otro por celular/contacto
 * dentro del negocio. Las respuestas con datos personales no se cachean.
 */
import {
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
    return c.json(await getCard(c.var.deps.db, c.req.param('token')));
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
