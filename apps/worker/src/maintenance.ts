/**
 * Mantenimiento de producción (lo programa el worker):
 * - limpieza diaria de datos temporales que ya no sirven (la base gratis tiene 500 MB);
 * - control cada 15 minutos: tamaño de la base, recursos del servidor y atrasos de Wallet,
 *   con aviso antes de que afecte al negocio.
 * Nunca toca el ledger, los clientes, la auditoría ni los reportes.
 */
import { schema, withSystemTx, type Db } from '@aiment/db';
import { hostStats, type Alerter, type HostStats } from '@aiment/ops';
import { and, isNotNull, lt, or, sql } from 'drizzle-orm';

export const CLEANUP_QUEUE = 'ops.cleanup';
/** 08:30 UTC = 03:30 en Lima, cuando no hay cajas abiertas. */
export const CLEANUP_CRON = '30 8 * * *';
export const HEALTH_QUEUE = 'ops.health';
export const HEALTH_CRON = '*/15 * * * *';

/** Días que se conservan los datos temporales ya vencidos o usados (para revisar incidentes). */
export const TEMP_RETENTION_DAYS = 30;

export interface CleanupResult {
  outboxEvents: number;
  staffSessions: number;
  devicePairings: number;
  recoveryTokens: number;
}

/** Borra lo temporal vencido o usado hace más de `days` días. Idempotente. */
export async function cleanupTemporaryData(
  db: Db,
  now = new Date(),
  days = TEMP_RETENTION_DAYS,
): Promise<CleanupResult> {
  const before = new Date(now.getTime() - days * 86_400_000);
  const { eventOutbox, staffSessions, devicePairings, cardRecoveryTokens } = schema;
  return withSystemTx(db, async (tx) => {
    // Eventos ya entregados al worker (los pendientes nunca se borran).
    const outbox = await tx
      .delete(eventOutbox)
      .where(and(isNotNull(eventOutbox.dispatchedAt), lt(eventOutbox.dispatchedAt, before)))
      .returning({ id: eventOutbox.id });
    // Turnos de caja vencidos o cerrados.
    const sessions = await tx
      .delete(staffSessions)
      .where(or(lt(staffSessions.expiresAt, before), lt(staffSessions.revokedAt, before)))
      .returning({ id: staffSessions.id });
    // Códigos para vincular una caja, ya vencidos.
    const pairings = await tx
      .delete(devicePairings)
      .where(lt(devicePairings.expiresAt, before))
      .returning({ id: devicePairings.id });
    // Enlaces de recuperación de tarjeta vencidos (los usados también vencen).
    const recovery = await tx
      .delete(cardRecoveryTokens)
      .where(lt(cardRecoveryTokens.expiresAt, before))
      .returning({ id: cardRecoveryTokens.id });
    return {
      outboxEvents: outbox.length,
      staffSessions: sessions.length,
      devicePairings: pairings.length,
      recoveryTokens: recovery.length,
    };
  });
}

export interface HealthThresholds {
  dbWarnMb: number;
  dbCriticalMb: number;
  memPct: number;
  diskPct: number;
  /** Carga de 5 min por núcleo. */
  loadPerCore: number;
  /** Minutos que un evento puede esperar sin despacharse. */
  outboxLagMinutes: number;
  /** Pases con error de sincronización (sin contar los que esperan reintento). */
  walletErrors: number;
}

export const DEFAULT_THRESHOLDS: HealthThresholds = {
  dbWarnMb: 300,
  dbCriticalMb: 400,
  memPct: 75,
  diskPct: 70,
  loadPerCore: 0.75,
  outboxLagMinutes: 10,
  walletErrors: 20,
};

export interface HealthSnapshot {
  dbSizeMb: number;
  host: HostStats;
  outboxLagMinutes: number;
  walletErrors: number;
}

export async function healthSnapshot(db: Db): Promise<HealthSnapshot> {
  const [row] = await withSystemTx(db, (tx) =>
    tx.execute(sql`
      select pg_database_size(current_database())::bigint as bytes,
             coalesce(extract(epoch from now() - min(o.created_at)) / 60, 0)::float as lag,
             (select count(*)::int from app.wallet_passes w where w.status = 'active' and w.last_error is not null) as wallet_errors
      from (select created_at from app.event_outbox where dispatched_at is null) o`),
  );
  const r = row as { bytes: string | number; lag: number; wallet_errors: number };
  return {
    dbSizeMb: Math.round((Number(r.bytes) / 1_048_576) * 10) / 10,
    host: await hostStats(),
    outboxLagMinutes: Math.round(Number(r.lag) * 10) / 10,
    walletErrors: r.wallet_errors,
  };
}

/** Compara con los umbrales y avisa. Devuelve la foto para el log. */
export async function runHealthCheck(
  db: Db,
  alerter: Alerter,
  t: HealthThresholds = DEFAULT_THRESHOLDS,
): Promise<HealthSnapshot> {
  const s = await healthSnapshot(db);
  const checks: { key: string; bad: boolean; critical?: boolean; message: string }[] = [
    {
      key: 'db-size',
      bad: s.dbSizeMb >= t.dbWarnMb,
      critical: s.dbSizeMb >= t.dbCriticalMb,
      message: `La base de datos ocupa ${s.dbSizeMb} MB (aviso: ${t.dbWarnMb} MB · pasar a Supabase Pro antes de ${t.dbCriticalMb} MB; a los 500 MB el plan gratis queda en solo lectura y la caja no puede sumar).`,
    },
    {
      key: 'memory',
      bad: s.host.memUsedPct >= t.memPct,
      message: `RAM del servidor al ${s.host.memUsedPct}% (umbral ${t.memPct}%).`,
    },
    {
      key: 'disk',
      bad: (s.host.diskUsedPct ?? 0) >= t.diskPct,
      message: `Disco del servidor al ${s.host.diskUsedPct}% (umbral ${t.diskPct}%).`,
    },
    {
      key: 'cpu-load',
      bad: s.host.loadPerCore >= t.loadPerCore,
      message: `Carga del servidor ${s.host.loadPerCore} por núcleo en 5 minutos (umbral ${t.loadPerCore}).`,
    },
    {
      key: 'outbox-lag',
      bad: s.outboxLagMinutes >= t.outboxLagMinutes,
      message: `Hay eventos sin procesar hace ${s.outboxLagMinutes} min: los pases de Wallet no se están actualizando.`,
    },
    {
      key: 'wallet-errors',
      bad: s.walletErrors >= t.walletErrors,
      message: `${s.walletErrors} pases de Wallet con error de sincronización (ver wallet_passes.last_error).`,
    },
  ];
  for (const c of checks) {
    if (c.bad)
      await alerter.notify({ key: c.key, level: c.critical ? 'critical' : 'warning', message: c.message });
    else alerter.clear(c.key);
  }
  return s;
}
