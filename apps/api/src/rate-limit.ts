/**
 * Límite de intentos en memoria (ventana fija). Suficiente para una instancia; con varias
 * instancias en producción (semana 9) se moverá a Postgres o al borde (Cloudflare).
 *
 * Por qué no basta la IP: los clientes de un mismo local suelen salir por la MISMA IP pública
 * (Wi-Fi del negocio) y en Perú los operadores móviles comparten una IP entre muchos celulares
 * (CGNAT). Por eso el límite por IP es holgado (frena ráfagas o bots) y el control fino va por
 * lo que identifica al intento: el celular o contacto dentro del negocio, o el dispositivo de caja.
 * Detalle y valores: docs/decisiones/0003-limites-de-intentos.md
 */
export interface RateLimits {
  /** Registros por IP cada 10 minutos. */
  register: number;
  /** Registros del mismo celular en el mismo negocio cada 10 minutos. */
  registerPhone: number;
  /** Pedidos de recuperación por IP cada 10 minutos. */
  recovery: number;
  /** Pedidos de recuperación del mismo correo/celular en el mismo negocio cada 10 minutos. */
  recoveryContact: number;
  /** Aperturas de enlace de recuperación por IP cada 10 minutos (el enlace es de 128 bits). */
  redeem: number;
  /** Lecturas de tarjeta/QR/landing por IP por minuto. */
  publicRead: number;
  /** Aperturas de QR de autorización de dispositivo por IP cada 10 minutos. */
  devicePair: number;
  /** Intentos de PIN para abrir turno por dispositivo cada 10 minutos (además del bloqueo por persona). */
  staffLogin: number;
  /** Búsquedas de clientes por dispositivo por minuto. */
  staffSearch: number;
  /** Intentos de PIN del dueño (excepciones) por dispositivo cada 15 minutos. */
  staffOverride: number;
}

export const DEFAULT_RATE_LIMITS: RateLimits = {
  register: 30,
  registerPhone: 3,
  recovery: 20,
  recoveryContact: 3,
  redeem: 30,
  publicRead: 300,
  devicePair: 10,
  staffLogin: 20,
  staffSearch: 30,
  staffOverride: 10,
};

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
