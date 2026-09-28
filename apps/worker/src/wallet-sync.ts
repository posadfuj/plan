import { schema, withSystemTx, type Db } from '@aiment/db';
import type { WalletPassRef, WalletProvider } from '@aiment/wallet';
import { and, eq, sql } from 'drizzle-orm';
import { loadMembershipView } from './membership-view';

export interface SyncResult {
  synced: number;
  failed: { externalId: string; error: string }[];
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
): Promise<SyncResult> {
  const { view, passes } = await withSystemTx(db, async (tx) => ({
    view: await loadMembershipView(tx, membershipId, publicBaseUrl),
    passes: await tx
      .select({
        walletPassId: schema.walletPasses.id,
        provider: schema.walletPasses.provider,
        issuerRef: schema.walletPasses.issuerRef,
        externalId: schema.walletPasses.externalId,
      })
      .from(schema.walletPasses)
      .where(
        and(eq(schema.walletPasses.membershipId, membershipId), eq(schema.walletPasses.status, 'active')),
      ),
  }));
  if (!view) return { synced: 0, failed: [] };

  const result: SyncResult = { synced: 0, failed: [] };
  for (const pass of passes as WalletPassRef[]) {
    const provider = providers.find((p) => p.name === pass.provider && p.handles(pass.issuerRef));
    if (!provider) {
      result.failed.push({
        externalId: pass.externalId,
        error: `Sin proveedor configurado para ${pass.issuerRef}`,
      });
      continue;
    }
    try {
      await provider.update(view, pass);
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
      result.failed.push({ externalId: pass.externalId, error: message });
    }
  }
  return result;
}
