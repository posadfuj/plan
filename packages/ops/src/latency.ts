/**
 * Tiempos de respuesta de la caja: ventana móvil por minuto (sin guardar datos de clientes).
 * Da el p95 y los errores 5xx de los últimos N minutos.
 */
export class LatencyWindow {
  private readonly buckets = new Map<number, { ms: number[]; errors: number }>();

  constructor(
    private readonly windowMinutes = 15,
    private readonly now: () => number = Date.now,
  ) {}

  record(ms: number, status: number) {
    const minute = Math.floor(this.now() / 60_000);
    const b = this.buckets.get(minute) ?? { ms: [], errors: 0 };
    b.ms.push(ms);
    if (status >= 500) b.errors++;
    this.buckets.set(minute, b);
    for (const k of this.buckets.keys()) if (k <= minute - this.windowMinutes) this.buckets.delete(k);
  }

  stats(): { count: number; p95: number | null; errors: number } {
    const from = Math.floor(this.now() / 60_000) - this.windowMinutes + 1;
    const all: number[] = [];
    let errors = 0;
    for (const [k, b] of this.buckets)
      if (k >= from) {
        all.push(...b.ms);
        errors += b.errors;
      }
    if (!all.length) return { count: 0, p95: null, errors };
    all.sort((a, b) => a - b);
    return {
      count: all.length,
      p95: all[Math.min(all.length - 1, Math.ceil(all.length * 0.95) - 1)]!,
      errors,
    };
  }
}
