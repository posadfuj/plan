/**
 * Rutas públicas del cliente final (sin sesión). Se accede por código de sucursal o por tokens.
 * Todas tienen límite de intentos por IP y las respuestas con datos personales no se cachean.
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
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../context';
import { HttpError } from '../errors';
import { DEFAULT_RATE_LIMITS, type RateLimits } from '../rate-limit';

const TEN_MIN = 10 * 60_000;

export function clientIp(c: Context<AppEnv>): string {
  if (c.var.deps.config.trustProxy) {
    const xff = c.req.header('x-forwarded-for');
    if (xff) return xff.split(',')[0]!.trim();
    const cf = c.req.header('cf-connecting-ip');
    if (cf) return cf;
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function limit(c: Context<AppEnv>, bucket: keyof RateLimits, windowMs: number) {
  const max = c.var.deps.config.rateLimits?.[bucket] ?? DEFAULT_RATE_LIMITS[bucket];
  const r = c.var.deps.limiter.hit(`${bucket}:${clientIp(c)}`, max, windowMs);
  if (!r.ok) {
    c.header('Retry-After', String(r.retryAfter));
    throw new HttpError(
      429,
      'rate_limited',
      'Demasiados intentos. Espera unos minutos y vuelve a intentarlo.',
    );
  }
}

/** Cabeceras para respuestas con datos privados del cliente. */
function privateHeaders(c: Context<AppEnv>) {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Robots-Tag', 'noindex, nofollow');
}

async function json(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const b = await c.req.json().catch(() => ({}));
  return b && typeof b === 'object' ? (b as Record<string, unknown>) : {};
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
