import { sql } from 'drizzle-orm';
import type { Db, Tx } from './client';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ejecuta `fn` en una transacción limitada a una organización.
 * RLS (segunda capa) solo deja ver/escribir filas de `orgId`.
 */
export async function withTenantTx<T>(db: Db, orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID_RE.test(orgId)) throw new Error('withTenantTx: orgId inválido');
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

/**
 * Transacción de sistema (worker, servicio web de Apple, resolución de membresías de un usuario).
 * Ve todas las organizaciones: usar solo en código de plataforma, nunca con input de un tenant sin filtrar.
 */
export async function withSystemTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.scope', 'system', true)`);
    return fn(tx);
  });
}
