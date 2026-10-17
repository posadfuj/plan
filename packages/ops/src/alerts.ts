/**
 * Avisos de operación (base cerca del límite, disco, caja lenta…). Llegan antes de que el negocio
 * lo note: por correo (Resend) y/o a un webhook (p. ej. un flujo de n8n que reenvía a WhatsApp).
 * Un mismo aviso no se repite antes de `repeatAfterMs` (por defecto 6 h) para no saturar.
 */
import type { Mailer } from '@aiment/mail';

export type AlertLevel = 'warning' | 'critical';

export interface Alert {
  /** Estable por problema (p. ej. "db-size"): sirve para no repetir el mismo aviso. */
  key: string;
  level: AlertLevel;
  message: string;
}

export interface AlerterOptions {
  /** De dónde viene el aviso (api, worker). */
  source: string;
  webhookUrl?: string | undefined;
  email?: { mailer: Mailer; to: string } | undefined;
  log?: (msg: string) => void;
  repeatAfterMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

export class Alerter {
  private readonly lastSent = new Map<string, number>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: AlerterOptions) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? Date.now;
  }

  /** true si el aviso salió; false si se omitió por repetido. Nunca lanza: avisar no puede romper nada. */
  async notify(alert: Alert): Promise<boolean> {
    const id = `${alert.level}:${alert.key}`;
    const last = this.lastSent.get(id);
    if (last !== undefined && this.now() - last < (this.opts.repeatAfterMs ?? 6 * 3_600_000)) return false;
    this.lastSent.set(id, this.now());
    const text = `[Aiment Wallet · ${this.opts.source}] ${alert.level === 'critical' ? 'CRÍTICO' : 'Aviso'}: ${alert.message}`;
    this.opts.log?.(text);
    const sends: Promise<unknown>[] = [];
    if (this.opts.webhookUrl)
      sends.push(
        this.fetchImpl(this.opts.webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...alert,
            source: this.opts.source,
            text,
            at: new Date(this.now()).toISOString(),
          }),
          signal: AbortSignal.timeout(10_000),
        }),
      );
    if (this.opts.email)
      sends.push(
        this.opts.email.mailer.send({
          to: this.opts.email.to,
          subject: `${alert.level === 'critical' ? '[CRÍTICO]' : '[Aviso]'} Aiment Wallet: ${alert.key}`,
          text,
        }),
      );
    const results = await Promise.allSettled(sends);
    for (const r of results)
      if (r.status === 'rejected') this.opts.log?.(`[alertas] no se pudo enviar el aviso ${alert.key}`);
    return true;
  }

  /** El problema se resolvió: el próximo aviso de esa clave sale sin esperar. */
  clear(key: string) {
    for (const id of [...this.lastSent.keys()]) if (id.endsWith(`:${key}`)) this.lastSent.delete(id);
  }
}
