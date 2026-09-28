import { schema, withSystemTx, type Db } from '@aiment/db';
import { asc, inArray, isNull, sql } from 'drizzle-orm';

/** Eventos que cambian lo que se ve en un pase y disparan una sincronización de Wallet. */
export const WALLET_EVENTS = new Set([
  'ledger.created',
  'reward.earned',
  'reward.redeemed',
  'membership.updated',
  'wallet.resync_requested',
]);

export const QUEUES = { walletSync: 'wallet.sync' } as const;

export interface WalletSyncJob {
  membershipId: string;
  organizationId: string;
  eventId: number;
}

export type Enqueue = (queue: string, data: WalletSyncJob, key: string) => Promise<unknown>;

/**
 * Lee eventos pendientes del outbox, los encola y los marca como despachados.
 * Entrega "al menos una vez": los consumidores deben ser idempotentes (la sincronización de Wallet lo es,
 * porque siempre envía el estado actual leído de la base).
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

    for (const e of events) {
      if (WALLET_EVENTS.has(e.type)) {
        await enqueue(
          QUEUES.walletSync,
          { membershipId: e.aggregateId, organizationId: e.organizationId, eventId: e.id },
          e.aggregateId,
        );
      }
      // Otros tipos (automatizaciones, links) tendrán consumidores desde las semanas 3 y 6.
    }

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
