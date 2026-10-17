import { schema, withSystemTx, type Db } from '@aiment/db';
import { and, eq } from 'drizzle-orm';
import type { WalletProvider } from './types';
import { loadMembershipView } from './view';

const { walletPasses } = schema;

export type WalletLinkResult =
  | { status: 'ok'; addUrl: string; externalId: string }
  /** Tarjeta pausada por el negocio: no se entrega un pase con QR. */
  | { status: 'blocked' }
  | { status: 'not_found' };

/**
 * Enlace para agregar la tarjeta al Wallet. Un pase activo por membresía y proveedor:
 * - si ya existe, se regenera el enlace del MISMO pase (con el estado actual);
 * - si existe uno de otra cuenta emisora (migración), queda revocado y se emite uno nuevo;
 * - dos toques simultáneos no crean dos pases (índice único + relectura).
 * No toca el ledger ni depende de que el proveedor responda (el enlace se arma localmente).
 */
export async function requestWalletLink(
  db: Db,
  provider: WalletProvider,
  membershipId: string,
  publicBaseUrl: string,
): Promise<WalletLinkResult> {
  const view = await withSystemTx(db, (tx) => loadMembershipView(tx, membershipId, publicBaseUrl));
  if (!view) return { status: 'not_found' };
  if (view.status === 'blocked') return { status: 'blocked' };

  const activePass = () =>
    withSystemTx(db, async (tx) => {
      const [p] = await tx
        .select({
          id: walletPasses.id,
          issuerRef: walletPasses.issuerRef,
          externalId: walletPasses.externalId,
        })
        .from(walletPasses)
        .where(
          and(
            eq(walletPasses.membershipId, membershipId),
            eq(walletPasses.provider, provider.name),
            eq(walletPasses.status, 'active'),
          ),
        );
      return p;
    });

  let current = await activePass();
  if (current && !provider.handles(current.issuerRef)) {
    await withSystemTx(db, (tx) =>
      tx
        .update(walletPasses)
        .set({ status: 'revoked', updatedAt: new Date() })
        .where(eq(walletPasses.id, current!.id)),
    );
    current = undefined;
  }
  if (current) {
    const r = await provider.issue(view, current.externalId);
    return { status: 'ok', addUrl: r.addUrl, externalId: r.externalId };
  }

  const issued = await provider.issue(view);
  const inserted = await withSystemTx(db, (tx) =>
    tx
      .insert(walletPasses)
      .values({
        organizationId: view.organizationId,
        membershipId,
        provider: provider.name,
        issuerRef: issued.issuerRef,
        externalId: issued.externalId,
        // El enlace lleva el estado actual: el pase nace sincronizado.
        lastSyncedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: walletPasses.id }),
  );
  if (inserted.length) return { status: 'ok', addUrl: issued.addUrl, externalId: issued.externalId };

  // Otro toque creó el pase un instante antes: se usa ese.
  const winner = await activePass();
  if (!winner) throw new Error('No se pudo registrar el pase de Wallet');
  const r = await provider.issue(view, winner.externalId);
  return { status: 'ok', addUrl: r.addUrl, externalId: r.externalId };
}
