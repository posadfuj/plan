/**
 * Límite de intentos en memoria (ventana fija). Suficiente para una instancia; con varias
 * instancias en producción (semana 9) se moverá a Postgres o al borde (Cloudflare).
 */
export interface RateLimits {
  /** Registros por IP cada 10 minutos. */
  register: number;
  /** Pedidos de recuperación por IP cada 10 minutos. */
  recovery: number;
  /** Aperturas de enlace de recuperación por IP cada 10 minutos. */
  redeem: number;
  /** Lecturas de tarjeta/QR por IP por minuto. */
  publicRead: number;
}

export const DEFAULT_RATE_LIMITS: RateLimits = { register: 5, recovery: 5, redeem: 10, publicRead: 120 };

export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  /** Registra un intento; devuelve los segundos de espera si se superó el límite. */
  hit(
    key: string,
    limit: number,
    windowMs: number,
    now = Date.now(),
  ): { ok: true } | { ok: false; retryAfter: number } {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + windowMs });
      if (this.hits.size > 50_000) this.sweep(now);
      return { ok: true };
    }
    entry.count++;
    if (entry.count > limit) return { ok: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
    return { ok: true };
  }

  private sweep(now: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}
