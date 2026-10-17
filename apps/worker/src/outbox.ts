import { schema, withSystemTx, type Db } from '@aiment/db';
import type { WalletProviderName } from '@aiment/wallet';
import { and, asc, inArray, isNull, sql } from 'drizzle-orm';

/** Eventos que cambian lo que se ve en un pase y disparan una sincronización de Wallet. */
export const WALLET_EVENTS = new Set([
  'ledger.created',
  'reward.earned',
  'reward.redeemed',
  'reward.expired',
  'membership.updated',
  'wallet.resync_requested',
]);
/** Cliente eliminado: sus pases se cierran en el Wallet (sin nombre ni QR). */
export const WALLET_REVOKE_EVENTS = new Set(['membership.closed']);

/**
 * Una cola por proveedor: si Google falla, se reintenta solo Google; Apple no repite trabajo
 * (y viceversa). Cada cola tiene su propia política de reintentos.
 */
export const WALLET_QUEUES: Record<WalletProviderName, string> = {
  google: 'wallet.sync.google',
  apple: 'wallet.sync.apple',
};

export interface WalletSyncJob {
  membershipId: string;
  organizationId: string;
  provider: WalletProviderName;
  eventId: number;
  /** sync (por defecto) = enviar el estado actual · revoke = cerrar los pases revocados. */
  action?: 'sync' | 'revoke';
}

export type Enqueue = (queue: string, data: WalletSyncJob, key: string) => Promise<unknown>;

/**
 * Lee eventos pendientes del outbox, los encola y los marca como despachados.
 * - Solo encola proveedores en los que la membresía tiene un pase activo.
 * - Varios eventos de una misma membresía en el lote → un solo job por proveedor.
 * Entrega "al menos una vez": la sincronización es idempotente (envía el estado actual de la base).
 */
export async function dispatchOutboxBatch(db: Db, enqueue: Enqueue, limit = 100): Promise<number> {
  return withSystemTx(db, async (tx) => {
    const events = await tx
      .select()
      .from(schema.eventOutbox)
      .where(isNull(schema.eventOutbox.dispatchedAt))
      .orderBy(asc(schema.eventOutbox.id))
      .limit(limit)
      .for('update', { skipLocked: true });
    if (!events.length) return 0;

    const walletEvents = events.filter((e) => WALLET_EVENTS.has(e.type) || WALLET_REVOKE_EVENTS.has(e.type));
    const membershipIds = [...new Set(walletEvents.map((e) => e.aggregateId))];
    const passes = membershipIds.length
      ? await tx
          .selectDistinct({
            membershipId: schema.walletPasses.membershipId,
            provider: schema.walletPasses.provider,
            status: schema.walletPasses.status,
          })
          .from(schema.walletPasses)
          .where(
            and(
              inArray(schema.walletPasses.membershipId, membershipIds),
              inArray(schema.walletPasses.status, ['active', 'revoked']),
            ),
          )
      : [];

    const queued = new Set<string>();
    for (const e of walletEvents) {
      const action = WALLET_REVOKE_EVENTS.has(e.type) ? 'revoke' : 'sync';
      const wanted = action === 'revoke' ? 'revoked' : 'active';
      for (const p of passes.filter((x) => x.membershipId === e.aggregateId && x.status === wanted)) {
        const jobKey =
          action === 'revoke' ? `${p.provider}:revoke:${e.aggregateId}` : `${p.provider}:${e.aggregateId}`;
        if (queued.has(jobKey)) continue;
        queued.add(jobKey);
        await enqueue(
          WALLET_QUEUES[p.provider],
          {
            membershipId: e.aggregateId,
            organizationId: e.organizationId,
            provider: p.provider,
            eventId: e.id,
            ...(action === 'revoke' ? { action } : {}),
          },
          jobKey,
        );
      }
    }
    // Otros tipos (program.updated, automatizaciones, links) tendrán consumidores en las semanas 3, 6 y 7.

    await tx
      .update(schema.eventOutbox)
      .set({ dispatchedAt: new Date(), attempts: sql`${schema.eventOutbox.attempts} + 1` })
      .where(
        inArray(
          schema.eventOutbox.id,
          events.map((e) => e.id),
        ),
      );
    return events.length;
  });
}
