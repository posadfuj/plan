import { schema, withSystemTx, type Db } from '@aiment/db';
import {
  loadMembershipView,
  WalletProviderError,
  type WalletPassRef,
  type WalletProvider,
  type WalletProviderName,
} from '@aiment/wallet';
import { and, eq, sql } from 'drizzle-orm';

export interface SyncResult {
  synced: number;
  /** retryable=false: reintentar no lo arregla (datos o permisos); se registra y no se reintenta. */
  failed: { externalId: string; error: string; retryable: boolean }[];
}

const passFields = {
  walletPassId: schema.walletPasses.id,
  provider: schema.walletPasses.provider,
  issuerRef: schema.walletPasses.issuerRef,
  externalId: schema.walletPasses.externalId,
};

/**
 * Aplica `op` a cada pase y registra el resultado en wallet_passes. Un fallo de un proveedor
 * nunca toca el saldo: la base es la fuente de verdad y el job se reintenta.
 */
async function forEachPass(
  db: Db,
  providers: WalletProvider[],
  passes: WalletPassRef[],
  op: (provider: WalletProvider, pass: WalletPassRef) => Promise<void>,
): Promise<SyncResult> {
  const result: SyncResult = { synced: 0, failed: [] };
  for (const pass of passes) {
    const provider = providers.find((p) => p.name === pass.provider && p.handles(pass.issuerRef));
    try {
      // Pase de una cuenta emisora que este entorno no tiene configurada: reintentar no sirve.
      if (!provider) throw new WalletProviderError(`Sin proveedor configurado para ${pass.issuerRef}`, false);
      await op(provider, pass);
      await withSystemTx(db, (tx) =>
        tx
          .update(schema.walletPasses)
          .set({
            lastSyncedAt: new Date(),
            lastError: null,
            passVersion: sql`${schema.walletPasses.passVersion} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(schema.walletPasses.id, pass.walletPassId)),
      );
      result.synced++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await withSystemTx(db, (tx) =>
        tx
          .update(schema.walletPasses)
          .set({ lastError: message.slice(0, 500) })
          .where(eq(schema.walletPasses.id, pass.walletPassId)),
      );
      result.failed.push({
        externalId: pass.externalId,
        error: message,
        retryable: !(err instanceof WalletProviderError) || err.retryable,
      });
    }
  }
  return result;
}

/**
 * Sincroniza todos los pases activos de una membresía con el estado actual de la base.
 * La base es la fuente de verdad: si un proveedor falla, el saldo no se ve afectado y el job se reintenta.
 */
export async function syncMembershipPasses(
  db: Db,
  providers: WalletProvider[],
  membershipId: string,
  publicBaseUrl: string,
  /** Si se indica, solo sincroniza los pases de ese proveedor (un job por proveedor). */
  onlyProvider?: WalletProviderName,
): Promise<SyncResult> {
  const { view, passes } = await withSystemTx(db, async (tx) => ({
    view: await loadMembershipView(tx, membershipId, publicBaseUrl),
    passes: await tx
      .select(passFields)
      .from(schema.walletPasses)
      .where(
        and(
          eq(schema.walletPasses.membershipId, membershipId),
          eq(schema.walletPasses.status, 'active'),
          onlyProvider ? eq(schema.walletPasses.provider, onlyProvider) : undefined,
        ),
      ),
  }));
  if (!view) return { synced: 0, failed: [] };
  return forEachPass(db, providers, passes as WalletPassRef[], (p, pass) => p.update(view, pass));
}

/**
 * Cliente eliminado: sus pases ya quedaron `revoked` en la base; aquí se cierran también en el
 * Wallet (inactivos y sin nombre). Idempotente: repetirlo no cambia nada.
 */
export async function revokeMembershipPasses(
  db: Db,
  providers: WalletProvider[],
  membershipId: string,
  onlyProvider?: WalletProviderName,
): Promise<SyncResult> {
  const passes = await withSystemTx(db, (tx) =>
    tx
      .select(passFields)
      .from(schema.walletPasses)
      .where(
        and(
          eq(schema.walletPasses.membershipId, membershipId),
          eq(schema.walletPasses.status, 'revoked'),
          onlyProvider ? eq(schema.walletPasses.provider, onlyProvider) : undefined,
        ),
      ),
  );
  return forEachPass(db, providers, passes as WalletPassRef[], (p, pass) => p.revoke(pass));
}
