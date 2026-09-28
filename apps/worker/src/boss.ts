import { PgBoss } from 'pg-boss';
import type { Db } from '@aiment/db';
import type { WalletProvider } from '@aiment/wallet';
import { dispatchOutboxBatch, QUEUES, type WalletSyncJob } from './outbox';
import { syncMembershipPasses } from './wallet-sync';

export interface WorkerOptions {
  databaseUrl: string;
  db: Db;
  providers: WalletProvider[];
  publicBaseUrl: string;
  /** Segundos para agrupar sincronizaciones seguidas de la misma membresía. */
  debounceSeconds?: number;
  retry?: { limit: number; delaySeconds: number; backoff: boolean };
  pollSeconds?: number;
  log?: (msg: string) => void;
}

/** Arranca pg-boss, registra el consumidor de wallet.sync y el despachador del outbox. */
export async function startWorker(opts: WorkerOptions) {
  const log = opts.log ?? (() => {});
  const boss = new PgBoss({
    connectionString: opts.databaseUrl,
    schema: 'pgboss',
    max: 4,
    migrate: false,
    createSchema: false,
  });
  boss.on('error', (err) => log(`[pg-boss] ${err.message}`));
  await boss.start();

  const retry = opts.retry ?? { limit: 8, delaySeconds: 5, backoff: true };
  await boss.createQueue(QUEUES.walletSync, {
    retryLimit: retry.limit,
    retryDelay: retry.delaySeconds,
    retryBackoff: retry.backoff,
    ...(retry.backoff ? { retryDelayMax: 3600 } : {}),
  });

  await boss.work<WalletSyncJob>(
    QUEUES.walletSync,
    { pollingIntervalSeconds: opts.pollSeconds ?? 1 },
    async ([job]) => {
      if (!job) return;
      const r = await syncMembershipPasses(
        opts.db,
        opts.providers,
        job.data.membershipId,
        opts.publicBaseUrl,
      );
      if (r.failed.length) {
        log(
          `[wallet.sync] ${job.data.membershipId}: ${r.failed.length} pase(s) con error, se reintentará (intento ${job.retryCount + 1})`,
        );
        throw new Error(r.failed.map((f) => `${f.externalId}: ${f.error}`).join('; '));
      }
      log(`[wallet.sync] ${job.data.membershipId}: ${r.synced} pase(s) sincronizado(s)`);
    },
  );

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
      log(`[outbox] error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), 1000);

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
