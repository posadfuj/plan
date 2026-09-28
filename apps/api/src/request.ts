/** Utilidades de petición compartidas por las rutas públicas y las de caja. */
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import type { AppEnv } from './context';
import { HttpError } from './errors';
import { DEFAULT_RATE_LIMITS, type RateLimits } from './rate-limit';

export const TEN_MIN = 10 * 60_000;

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

/**
 * Cuenta un intento en `bucket` para `subject` (por defecto, la IP del cliente) y responde 429
 * si se superó el límite configurado.
 */
export function limit(
  c: Context<AppEnv>,
  bucket: keyof RateLimits,
  windowMs: number,
  subject: string = clientIp(c),
) {
  const max = c.var.deps.config.rateLimits?.[bucket] ?? DEFAULT_RATE_LIMITS[bucket];
  const r = c.var.deps.limiter.hit(`${bucket}:${subject}`, max, windowMs);
  if (!r.ok) {
    c.header('Retry-After', String(r.retryAfter));
    throw new HttpError(
      429,
      'rate_limited',
      'Demasiados intentos. Espera unos minutos y vuelve a intentarlo.',
    );
  }
}

/** Cabeceras para respuestas con datos privados. */
export function privateHeaders(c: Context<AppEnv>) {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Robots-Tag', 'noindex, nofollow');
}

export async function jsonBody(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const b = await c.req.json().catch(() => ({}));
  return b && typeof b === 'object' ? (b as Record<string, unknown>) : {};
}
