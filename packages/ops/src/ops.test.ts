import { MemoryMailer } from '@aiment/mail';
import { describe, expect, it } from 'vitest';
import { Alerter } from './alerts';
import { hostStats } from './host';
import { LatencyWindow } from './latency';

describe('avisos de operación', () => {
  it('avisa por webhook y correo; no repite el mismo aviso antes de 6 h; tras resolverse vuelve a avisar', async () => {
    let t = 0;
    const hooks: unknown[] = [];
    const mailer = new MemoryMailer();
    const alerter = new Alerter({
      source: 'worker',
      webhookUrl: 'https://n8n.example/webhook/aiment',
      email: { mailer, to: 'ops@aimentwallet.com' },
      fetch: (async (_u: string, init: RequestInit) => {
        hooks.push(JSON.parse(String(init.body)));
        return new Response('ok');
      }) as unknown as typeof fetch,
      now: () => t,
    });
    const alert = {
      key: 'db-size',
      level: 'warning' as const,
      message: 'La base llegó a 310 MB (aviso: 300 MB)',
    };
    expect(await alerter.notify(alert)).toBe(true);
    t += 3_600_000;
    expect(await alerter.notify(alert)).toBe(false); // 1 h después: no se repite
    expect(await alerter.notify({ ...alert, level: 'critical' })).toBe(true); // subir de nivel sí avisa
    alerter.clear('db-size');
    expect(await alerter.notify(alert)).toBe(true);
    expect(hooks).toHaveLength(3);
    expect(hooks[0]).toMatchObject({ key: 'db-size', level: 'warning', source: 'worker' });
    expect(mailer.sent[0]).toMatchObject({
      to: 'ops@aimentwallet.com',
      subject: '[Aviso] Aiment Wallet: db-size',
    });
  });

  it('si el webhook falla, el aviso igual sale por correo y nada se rompe', async () => {
    const mailer = new MemoryMailer();
    const alerter = new Alerter({
      source: 'api',
      webhookUrl: 'https://caido.example',
      email: { mailer, to: 'ops@aimentwallet.com' },
      fetch: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    await expect(alerter.notify({ key: 'x', level: 'critical', message: 'm' })).resolves.toBe(true);
    expect(mailer.sent).toHaveLength(1);
  });
});

describe('tiempos de la caja', () => {
  it('p95 y errores de los últimos 15 minutos; lo más viejo sale de la ventana', () => {
    let t = 0;
    const w = new LatencyWindow(15, () => t);
    for (let i = 1; i <= 100; i++) w.record(i * 10, i === 100 ? 500 : 200); // 10 ms … 1000 ms
    expect(w.stats()).toEqual({ count: 100, p95: 950, errors: 1 });
    t += 16 * 60_000;
    w.record(80, 200);
    expect(w.stats()).toEqual({ count: 1, p95: 80, errors: 0 });
  });
});

describe('recursos del servidor', () => {
  it('lee RAM, carga y disco en porcentajes razonables', async () => {
    const s = await hostStats();
    expect(s.memUsedPct).toBeGreaterThan(0);
    expect(s.memUsedPct).toBeLessThanOrEqual(100);
    expect(s.loadPerCore).toBeGreaterThanOrEqual(0);
    expect(s.diskUsedPct).toBeGreaterThan(0);
  });
});
