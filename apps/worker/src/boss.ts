import { PgBoss } from 'pg-boss';
import { safeError } from '@aiment/config';
import type { Db } from '@aiment/db';
import { WalletProviderError, type WalletProvider, type WalletProviderName } from '@aiment/wallet';
import type { Alerter } from '@aiment/ops';
import { EXPIRATION_CRON, EXPIRATION_QUEUE, runScheduledExpirations } from './expirations';
import {
  CLEANUP_CRON,
  CLEANUP_QUEUE,
  cleanupTemporaryData,
  DEFAULT_THRESHOLDS,
  HEALTH_CRON,
  HEALTH_QUEUE,
  runHealthCheck,
  type HealthThresholds,
} from './maintenance';
import { dispatchOutboxBatch, WALLET_QUEUES, type WalletSyncJob } from './outbox';
import {
  notifyMembershipPasses,
  revokeMembershipPasses,
  syncMembershipPasses,
  syncProgram,
  syncProgramMemberships,
} from './wallet-sync';

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
  /** Avisos de operación (base, servidor, atrasos de Wallet). Sin él no se programa el control. */
  alerter?: Alerter;
  thresholds?: HealthThresholds;
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

  const debounce = opts.debounceSeconds ?? 3;
  const enqueue = (queue: string, data: WalletSyncJob, key: string) =>
    debounce > 0 ? boss.sendDebounced(queue, data, null, debounce, key) : boss.send(queue, data);

  const retry = opts.retry ?? { limit: 8, delaySeconds: 5, backoff: true };
  // Una cola por proveedor. Puede haber varios del mismo proveedor (p. ej. dos cuentas emisoras
  // durante una migración): cada pase lo atiende el que reconoce su issuer_ref.
  const byName = new Map<WalletProviderName, WalletProvider[]>();
  for (const p of opts.providers) byName.set(p.name, [...(byName.get(p.name) ?? []), p]);
  for (const [name, providers] of byName) {
    const queue = WALLET_QUEUES[name];
    await boss.createQueue(queue, {
      // Trabajos terminados: 3 días alcanzan para revisar un incidente (la base gratis es chica).
      deleteAfterSeconds: 3 * 86_400,
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
        const { action, programId, runId } = job.data;
        const membershipId = job.data.membershipId ?? '';

        if (action === 'program') {
          // Marca o programa cambiados: la clase primero, después cada pase (con debounce).
          let memberships: string[];
          try {
            ({ memberships } = await syncProgram(opts.db, providers, programId!, opts.publicBaseUrl, name));
          } catch (err) {
            if (err instanceof WalletProviderError && !err.retryable) {
              log(`[${queue}] programa: ${err.message} (no se reintenta)`);
              memberships = (await syncProgramMemberships(opts.db, programId!, name)) ?? [];
            } else {
              log(`[${queue}] programa: ${safeError(err)}, se reintentará (intento ${job.retryCount + 1})`);
              throw err;
            }
          }
          for (const m of memberships)
            await enqueue(
              queue,
              {
                organizationId: job.data.organizationId,
                provider: name,
                eventId: job.data.eventId,
                membershipId: m,
              },
              `${name}:${m}`,
            );
          log(`[${queue}] programa actualizado: ${memberships.length} pase(s) a reenviar`);
          return;
        }

        const r =
          action === 'revoke'
            ? await revokeMembershipPasses(opts.db, providers, membershipId, name)
            : action === 'notify'
              ? await notifyMembershipPasses(
                  opts.db,
                  providers,
                  membershipId,
                  runId!,
                  opts.publicBaseUrl,
                  name,
                )
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
        const done = { revoke: 'cerrado(s)', notify: 'notificado(s)', sync: 'sincronizado(s)' }[
          action ?? 'sync'
        ];
        if (r.synced) log(`[${queue}] ${membershipId}: ${r.synced} pase(s) ${done}`);
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

  // Mantenimiento: limpieza diaria de datos temporales y control cada 15 minutos.
  await boss.createQueue(CLEANUP_QUEUE, { retryLimit: 2, retryDelay: 600, deleteAfterSeconds: 3 * 86_400 });
  await boss.work(CLEANUP_QUEUE, async () => {
    const r = await cleanupTemporaryData(opts.db);
    log(
      `[limpieza] eventos ${r.outboxEvents} · turnos ${r.staffSessions} · vinculaciones ${r.devicePairings} · recuperaciones ${r.recoveryTokens}`,
    );
  });
  if (opts.alerter) {
    const alerter = opts.alerter;
    await boss.createQueue(HEALTH_QUEUE, { retryLimit: 0, deleteAfterSeconds: 86_400 });
    await boss.work(HEALTH_QUEUE, async () => {
      const s = await runHealthCheck(opts.db, alerter, opts.thresholds ?? DEFAULT_THRESHOLDS);
      log(
        `[salud] base ${s.dbSizeMb} MB · RAM ${s.host.memUsedPct}% · disco ${s.host.diskUsedPct}% · carga ${s.host.loadPerCore}/núcleo · outbox ${s.outboxLagMinutes} min · Wallet con error ${s.walletErrors}`,
      );
    });
  }
  if (opts.scheduleExpirations !== false) {
    await boss.schedule(CLEANUP_QUEUE, CLEANUP_CRON);
    if (opts.alerter) await boss.schedule(HEALTH_QUEUE, HEALTH_CRON);
  }

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
