import { schema, withSystemTx, type Db } from '@aiment/db';
import type { WalletProviderName } from '@aiment/wallet';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

/** Eventos que cambian lo que se ve en un pase y disparan una sincronización de Wallet. */
export const WALLET_EVENTS = new Set([
  'ledger.created',
  'reward.earned',
  'reward.redeemed',
  'reward.expired',
  'membership.updated',
  'automation.ran', // el pase muestra el mismo mensaje que la tarjeta web
  'wallet.resync_requested',
]);
/** Cliente eliminado: sus pases se cierran en el Wallet (sin nombre ni QR). */
export const WALLET_REVOKE_EVENTS = new Set(['membership.closed']);
/** Mensajes automáticos que además llegan como notificación al celular. */
export const NOTIFY_KEYS = new Set(['goal_reached']);
/**
 * El dueño cambió la marca (nombre, color, logo) o el programa (nombre, unidad, regla, meta):
 * se actualiza lo común del programa y se reenvían todos sus pases.
 * program.updated → aggregateId = programa · organization.branding_updated → aggregateId = negocio.
 */
export const PROGRAM_EVENTS = new Set(['program.updated', 'organization.branding_updated']);

/**
 * Una cola por proveedor: si Google falla, se reintenta solo Google; Apple no repite trabajo
 * (y viceversa). Cada cola tiene su propia política de reintentos.
 */
export const WALLET_QUEUES: Record<WalletProviderName, string> = {
  google: 'wallet.sync.google',
  apple: 'wallet.sync.apple',
};

export interface WalletSyncJob {
  organizationId: string;
  provider: WalletProviderName;
  eventId: number;
  /**
   * sync (por defecto) = enviar el estado actual de una membresía · revoke = cerrar sus pases
   * revocados · notify = notificación de un mensaje automático (`runId`) · program = actualizar la
   * marca del programa (`programId`) y reenviar todos sus pases.
   */
  action?: 'sync' | 'revoke' | 'notify' | 'program';
  membershipId?: string;
  programId?: string;
  runId?: string;
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
    const send = async (provider: WalletProviderName, job: Omit<WalletSyncJob, 'provider'>, key: string) => {
      if (queued.has(key)) return;
      queued.add(key);
      await enqueue(WALLET_QUEUES[provider], { ...job, provider }, key);
    };
    for (const e of walletEvents) {
      const action = WALLET_REVOKE_EVENTS.has(e.type) ? 'revoke' : 'sync';
      const wanted = action === 'revoke' ? 'revoked' : 'active';
      for (const p of passes.filter((x) => x.membershipId === e.aggregateId && x.status === wanted)) {
        const base = { membershipId: e.aggregateId, organizationId: e.organizationId, eventId: e.id };
        await send(
          p.provider,
          action === 'revoke' ? { ...base, action } : base,
          action === 'revoke' ? `${p.provider}:revoke:${e.aggregateId}` : `${p.provider}:${e.aggregateId}`,
        );
        const run = e.payload as { key?: string; runId?: string } | null;
        if (e.type === 'automation.ran' && run?.runId && NOTIFY_KEYS.has(run.key ?? ''))
          await send(
            p.provider,
            { ...base, action: 'notify', runId: run.runId },
            `${p.provider}:notify:${run.runId}`,
          );
      }
    }

    // Cambios de marca o programa: un job por programa y proveedor con pases activos.
    const programEvents = events.filter((e) => PROGRAM_EVENTS.has(e.type));
    if (programEvents.length) {
      const programs = await tx
        .selectDistinct({
          programId: schema.memberships.programId,
          organizationId: schema.memberships.organizationId,
          provider: schema.walletPasses.provider,
        })
        .from(schema.walletPasses)
        .innerJoin(schema.memberships, eq(schema.memberships.id, schema.walletPasses.membershipId))
        .where(
          and(
            eq(schema.walletPasses.status, 'active'),
            inArray(schema.memberships.organizationId, [
              ...new Set(programEvents.map((e) => e.organizationId)),
            ]),
          ),
        );
      for (const e of programEvents) {
        const affected = programs.filter((x) =>
          e.type === 'program.updated' ? x.programId === e.aggregateId : x.organizationId === e.aggregateId,
        );
        for (const x of affected)
          await send(
            x.provider,
            { organizationId: x.organizationId, programId: x.programId, eventId: e.id, action: 'program' },
            `${x.provider}:program:${x.programId}`,
          );
      }
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
