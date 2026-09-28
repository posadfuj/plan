/**
 * Wallet simulado de punta a punta: outbox → pg-boss → sincronización de pases, con reintentos.
 * Corre con el usuario de la API (sin BYPASSRLS) contra la base de test.
 */
import { createDb, schema, withSystemTx, type DbHandle } from '@aiment/db';
import { SEED, seedMembershipId } from '@aiment/db/seed-data';
import { FakeWalletProvider } from '@aiment/wallet';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { startWorker } from './boss';
import { dispatchOutboxBatch } from './outbox';

const A = SEED.orgs.barberia;
const membershipId = seedMembershipId('barberia', 1); // tiene pase Google y Apple simulados

let handle: DbHandle;
let worker: Awaited<ReturnType<typeof startWorker>>;
const google = new FakeWalletProvider('google');
const apple = new FakeWalletProvider('apple');

async function emit(type: string, aggregateId = membershipId) {
  await withSystemTx(handle.db, (tx) =>
    tx
      .insert(schema.eventOutbox)
      .values({ organizationId: A.id, type, aggregateId, payload: { test: true } }),
  );
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('waitFor: tiempo agotado');
}

const passes = () =>
  withSystemTx(handle.db, (tx) =>
    tx
      .select({
        provider: schema.walletPasses.provider,
        version: schema.walletPasses.passVersion,
        lastError: schema.walletPasses.lastError,
        lastSyncedAt: schema.walletPasses.lastSyncedAt,
      })
      .from(schema.walletPasses)
      .where(eq(schema.walletPasses.membershipId, membershipId)),
  );

beforeAll(async () => {
  handle = createDb(inject('apiDbUrl'), { max: 4 });
  worker = await startWorker({
    databaseUrl: inject('apiDbUrl'),
    db: handle.db,
    providers: [google, apple],
    publicBaseUrl: 'http://localhost:5173',
    debounceSeconds: 0,
    retry: { limit: 3, delaySeconds: 1, backoff: false },
    pollSeconds: 0.5,
  });
});

afterAll(async () => {
  await worker?.stop();
  await handle?.close();
});

describe('Wallet simulado', () => {
  it('un evento del outbox sincroniza los pases Google y Apple con el saldo de la base', async () => {
    const [m] = await withSystemTx(handle.db, (tx) =>
      tx
        .select({ balance: schema.memberships.balance })
        .from(schema.memberships)
        .where(eq(schema.memberships.id, membershipId)),
    );
    await emit('ledger.created');
    await worker.tick();

    await waitFor(() => google.calls.length >= 1 && apple.calls.length >= 1);
    expect(google.calls[0]).toMatchObject({ op: 'update', membershipId, balance: m!.balance });
    expect(apple.calls[0]).toMatchObject({ op: 'update', membershipId, balance: m!.balance });

    await waitFor(async () => (await passes()).every((p) => p.lastSyncedAt !== null));
    const rows = await passes();
    expect(rows.every((p) => p.version === 2 && p.lastError === null)).toBe(true);
  });

  it('un evento ya despachado no se vuelve a despachar', async () => {
    expect(await dispatchOutboxBatch(handle.db, async () => {})).toBe(0);
  });

  it('si el proveedor falla, se registra el error y el job se reintenta hasta sincronizar', async () => {
    const before = google.calls.length;
    google.failNext(1);
    await emit('reward.earned');
    await worker.tick();

    await waitFor(
      async () => (await passes()).some((p) => p.provider === 'google' && p.lastError !== null),
      10_000,
    );
    await waitFor(() => google.calls.length > before, 15_000);
    await waitFor(async () => (await passes()).every((p) => p.lastError === null));
  });

  it('los eventos que no afectan pases se marcan como despachados sin generar trabajo', async () => {
    const before = google.calls.length + apple.calls.length;
    await emit('customer.registered');
    expect(
      await dispatchOutboxBatch(handle.db, async () => {
        throw new Error('no debería encolar');
      }),
    ).toBe(1);
    await new Promise((r) => setTimeout(r, 1500));
    expect(google.calls.length + apple.calls.length).toBe(before);
  });

  it('el worker opera con el rol de la API (sin privilegios especiales)', async () => {
    const [r] = await handle.sql`select rolbypassrls from pg_roles where rolname = current_user`;
    expect(r!.rolbypassrls).toBe(false);
    const [jobs] = await withSystemTx(handle.db, (tx) =>
      tx.execute(sql`select count(*)::int as n from pgboss.job`),
    );
    expect(Number((jobs as { n: number }).n)).toBeGreaterThan(0);
  });
});
