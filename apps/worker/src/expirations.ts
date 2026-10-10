/**
 * Vencimientos programados (semana 6). Un trabajo de pg-boss corre cada hora; en cada negocio
 * publicado actúa una vez al día, cuando en SU zona horaria son las 3:00 (fuera del horario de caja).
 *
 * - Premios ganados con vigencia (`rewards.validity_days`) que ya vencieron → `expired`.
 * - Saldos sin actividad por N meses, solo si el negocio configuró `expiration_months`
 *   (en el piloto está desactivado: no se toca ningún saldo).
 *
 * `expireInactive` es idempotente, así que reintentar o correr dos veces la misma hora no duplica nada.
 */
import { schema, withSystemTx, type Db } from '@aiment/db';
import { expireInactive } from '@aiment/ledger';
import { eq } from 'drizzle-orm';

export const EXPIRATION_QUEUE = 'loyalty.expire';
/** Minuto 7 de cada hora (UTC): no coincide con el cambio de hora exacto. */
export const EXPIRATION_CRON = '7 * * * *';
export const EXPIRATION_LOCAL_HOUR = 3;

/** Hora local (0–23) de `now` en una zona horaria IANA. */
export function localHour(now: Date, timeZone: string): number {
  const h = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(now);
  return Number(h);
}

export interface ExpirationRun {
  organizations: number;
  expiredMemberships: number;
  expiredRewards: number;
  failed: number;
}

export async function runScheduledExpirations(
  db: Db,
  now = new Date(),
  opts: { hour?: number; log?: (msg: string) => void } = {},
): Promise<ExpirationRun> {
  const hour = opts.hour ?? EXPIRATION_LOCAL_HOUR;
  const orgs = await withSystemTx(db, (tx) =>
    tx
      .select({ id: schema.organizations.id, timezone: schema.organizations.timezone })
      .from(schema.organizations)
      .where(eq(schema.organizations.status, 'live')),
  );
  const due = orgs.filter((o) => {
    try {
      return localHour(now, o.timezone) === hour;
    } catch {
      return false; // zona horaria inválida: no se adivina
    }
  });
  const run: ExpirationRun = {
    organizations: due.length,
    expiredMemberships: 0,
    expiredRewards: 0,
    failed: 0,
  };
  for (const org of due) {
    try {
      const r = await expireInactive(db, org.id, now);
      run.expiredMemberships += r.expiredMemberships;
      run.expiredRewards += r.expiredRewards;
    } catch (err) {
      // Un negocio con problemas no frena a los demás; el próximo día se reintenta.
      run.failed++;
      opts.log?.(`[vencimientos] negocio ${org.id}: ${err instanceof Error ? err.name : 'error'}`);
    }
  }
  return run;
}
