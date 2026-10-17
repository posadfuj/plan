import { PgBoss } from 'pg-boss';
import { safeError } from '@aiment/config';
import type { Db } from '@aiment/db';
import type { WalletProvider, WalletProviderName } from '@aiment/wallet';
import { EXPIRATION_CRON, EXPIRATION_QUEUE, runScheduledExpirations } from './expirations';
import { dispatchOutboxBatch, WALLET_QUEUES, type WalletSyncJob } from './outbox';
import { revokeMembershipPasses, syncMembershipPasses } from './wallet-sync';

export interface WorkerOptions {
  databaseUrl: string;
  db: Db;
  providers: WalletProvider[];
  publicBaseUrl: string;
  /** Segundos para agrupar sincronizaciones seguidas de la misma membresía. */
  debounceSeconds?: number;
  retry?: { limit: number; delaySeconds: number; backoff: boolean };
  pollSeconds?: number;
  /** false = el outbox solo se despacha al llamar `tick()` (tests deterministas). */
  autoDispatch?: boolean;
  /** false = no programa los vencimientos diarios (los tests los ejecutan a mano). */
  scheduleExpirations?: boolean;
  log?: (msg: string) => void;
}

/** Arranca pg-boss, registra un consumidor por proveedor de Wallet y el despachador del outbox. */
export async function startWorker(opts: WorkerOptions) {
  const log = opts.log ?? (() => {});
  const boss = new PgBoss({
    connectionString: opts.databaseUrl,
    schema: 'pgboss',
    max: 4,
    migrate: false,
    createSchema: false,
  });
  boss.on('error', (err) => log(`[pg-boss] ${safeError(err)}`));
  await boss.start();

  const retry = opts.retry ?? { limit: 8, delaySeconds: 5, backoff: true };
  // Una cola por proveedor. Puede haber varios del mismo proveedor (p. ej. dos cuentas emisoras
  // durante una migración): cada pase lo atiende el que reconoce su issuer_ref.
  const byName = new Map<WalletProviderName, WalletProvider[]>();
  for (const p of opts.providers) byName.set(p.name, [...(byName.get(p.name) ?? []), p]);
  for (const [name, providers] of byName) {
    const queue = WALLET_QUEUES[name];
    await boss.createQueue(queue, {
      retryLimit: retry.limit,
      retryDelay: retry.delaySeconds,
      retryBackoff: retry.backoff,
      ...(retry.backoff ? { retryDelayMax: 3600 } : {}),
    });
    await boss.work<WalletSyncJob>(
      queue,
      { pollingIntervalSeconds: opts.pollSeconds ?? 1 },
      async ([job]) => {
        if (!job) return;
        const { membershipId, action } = job.data;
        const r =
          action === 'revoke'
            ? await revokeMembershipPasses(opts.db, providers, membershipId, name)
            : await syncMembershipPasses(opts.db, providers, membershipId, opts.publicBaseUrl, name);
        const retryable = r.failed.filter((f) => f.retryable);
        for (const f of r.failed.filter((x) => !x.retryable))
          log(`[${queue}] ${membershipId}: ${f.error} (no se reintenta: queda en last_error)`);
        if (retryable.length) {
          log(
            `[${queue}] ${membershipId}: ${retryable.length} pase(s) con error, se reintentará (intento ${job.retryCount + 1})`,
          );
          throw new Error(retryable.map((f) => `${f.externalId}: ${f.error}`).join('; '));
        }
        if (r.synced)
          log(
            `[${queue}] ${membershipId}: ${r.synced} pase(s) ${action === 'revoke' ? 'cerrado(s)' : 'sincronizado(s)'}`,
          );
      },
    );
  }

  // Vencimientos: cada hora; cada negocio actúa a las 3:00 de su zona horaria (ver expirations.ts).
  await boss.createQueue(EXPIRATION_QUEUE, { retryLimit: 2, retryDelay: 300 });
  if (opts.scheduleExpirations !== false) await boss.schedule(EXPIRATION_QUEUE, EXPIRATION_CRON);
  await boss.work(EXPIRATION_QUEUE, async () => {
    const r = await runScheduledExpirations(opts.db, new Date(), { log });
    if (r.organizations)
      log(
        `[vencimientos] ${r.organizations} negocio(s): ${r.expiredRewards} premio(s) y ${r.expiredMemberships} saldo(s) vencidos${r.failed ? `, ${r.failed} con error` : ''}`,
      );
  });

  const debounce = opts.debounceSeconds ?? 3;
  const enqueue = (queue: string, data: WalletSyncJob, key: string) =>
    debounce > 0 ? boss.sendDebounced(queue, data, null, debounce, key) : boss.send(queue, data);

  let running = true;
  let busy = false;
  const tick = async () => {
    if (!running || busy) return;
    busy = true;
    try {
      const n = await dispatchOutboxBatch(opts.db, enqueue);
      if (n) log(`[outbox] ${n} evento(s) despachado(s)`);
    } catch (err) {
      log(`[outbox] error: ${safeError(err)}`);
    } finally {
      busy = false;
    }
  };
  const timer = opts.autoDispatch === false ? undefined : setInterval(() => void tick(), 1000);

  return {
    boss,
    tick,
    async stop() {
      running = false;
      clearInterval(timer);
      await boss.stop({ graceful: true, timeout: 5000 });
    },
  };
}
