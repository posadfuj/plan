/**
 * Wallet simulado de punta a punta: outbox → una cola por proveedor → sincronización de pases.
 * Corre con el usuario de la API (sin BYPASSRLS) contra la base de test.
 */
import { createDb, schema, withSystemTx, type DbHandle } from '@aiment/db';
import { SEED, seedMembershipId } from '@aiment/db/seed-data';
import { earn } from '@aiment/ledger';
import { createTestOrg } from '@aiment/ledger/test-fixtures';
import { FakeWalletProvider } from '@aiment/wallet';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { startWorker } from './boss';
import { EXPIRATION_CRON, EXPIRATION_QUEUE, runScheduledExpirations } from './expirations';
import { dispatchOutboxBatch, WALLET_QUEUES } from './outbox';

const A = SEED.orgs.barberia;
const both = seedMembershipId('barberia', 1); // pases Google y Apple simulados
const googleOnly = seedMembershipId('barberia', 3); // solo pase Google

let handle: DbHandle;
let worker: Awaited<ReturnType<typeof startWorker>>;
const google = new FakeWalletProvider('google');
const apple = new FakeWalletProvider('apple');

async function emit(type: string, aggregateId: string, orgId: string = A.id) {
  await withSystemTx(handle.db, (tx) =>
    tx
      .insert(schema.eventOutbox)
      .values({ organizationId: orgId, type, aggregateId, payload: { test: true } }),
  );
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('waitFor: tiempo agotado');
}
const settle = () => new Promise((r) => setTimeout(r, 1500));
const callsFor = (p: FakeWalletProvider, membershipId: string) =>
  p.calls.filter((c) => c.membershipId === membershipId).length;

const passes = (membershipId: string) =>
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
  handle = createDb(inject('apiDbUrl'), { max: 6 });
  worker = await startWorker({
    databaseUrl: inject('apiDbUrl'),
    db: handle.db,
    providers: [google, apple],
    publicBaseUrl: 'http://localhost:5173',
    debounceSeconds: 0,
    retry: { limit: 3, delaySeconds: 1, backoff: false },
    pollSeconds: 0.5,
    autoDispatch: false,
  });
});

afterAll(async () => {
  await worker?.stop();
  await handle?.close();
});

beforeEach(async () => {
  // Cada test parte con el outbox vacío (eventos de tests anteriores ya despachados).
  // En lotes: otras suites (registro, caja) pueden dejar más de un lote pendiente.
  while ((await dispatchOutboxBatch(handle.db, async () => {})) > 0);
});

describe('Wallet simulado: una cola por proveedor', () => {
  it('un evento sincroniza los pases Google y Apple con el saldo de la base', async () => {
    const [m] = await withSystemTx(handle.db, (tx) =>
      tx
        .select({ balance: schema.memberships.balance })
        .from(schema.memberships)
        .where(eq(schema.memberships.id, both)),
    );
    // Otras suites pueden haber sincronizado antes estos pases: se compara contra la versión previa.
    const before = new Map((await passes(both)).map((p) => [p.provider, p.version]));
    await emit('ledger.created', both);
    await worker.tick();
    await waitFor(() => callsFor(google, both) === 1 && callsFor(apple, both) === 1);
    expect(google.calls.at(-1)).toMatchObject({ op: 'update', membershipId: both, balance: m!.balance });
    await waitFor(async () =>
      (await passes(both)).every((p) => p.version === before.get(p.provider)! + 1 && p.lastError === null),
    );
  });

  it('si Google falla, se reintenta solo Google: Apple no repite trabajo', async () => {
    const g0 = callsFor(google, both);
    const a0 = callsFor(apple, both);
    google.failNext(1);
    await emit('reward.earned', both);
    await worker.tick();

    await waitFor(
      async () => (await passes(both)).some((p) => p.provider === 'google' && p.lastError !== null),
      10_000,
    );
    await waitFor(() => callsFor(google, both) === g0 + 1, 15_000); // el reintento tuvo éxito
    await waitFor(async () => (await passes(both)).every((p) => p.lastError === null));
    await settle();
    expect(callsFor(apple, both)).toBe(a0 + 1); // Apple se sincronizó una sola vez
  });

  it('solo se encolan los proveedores donde el cliente tiene pase', async () => {
    const queues: string[] = [];
    await emit('ledger.created', googleOnly);
    await dispatchOutboxBatch(handle.db, async (queue) => {
      queues.push(queue);
    });
    expect(queues).toEqual([WALLET_QUEUES.google]);
  });

  it('varios eventos de un mismo cliente en un lote → un job por proveedor', async () => {
    const jobs: string[] = [];
    for (let i = 0; i < 4; i++) await emit('ledger.created', both);
    expect(
      await dispatchOutboxBatch(handle.db, async (_q, _data, key) => {
        jobs.push(key);
      }),
    ).toBe(4);
    expect(jobs.sort()).toEqual([`apple:${both}`, `google:${both}`]);
  });

  it('una suma real del ledger llega a los pases con el nuevo saldo', async () => {
    const B = SEED.orgs.cafe;
    const m = seedMembershipId('cafe', 1);
    const r = await earn(handle.db, B.id, {
      membershipId: m,
      amount: 15,
      operator: {
        actorType: 'owner',
        orgUserId: B.owner.orgUserId,
        canVoidAny: true,
        canOverrideLimits: true,
      },
      idempotencyKey: `wk_${randomUUID().replaceAll('-', '')}`,
    });
    await worker.tick();
    await waitFor(() => google.calls.some((c) => c.membershipId === m && c.balance === r.membership.balance));
    await waitFor(() => apple.calls.some((c) => c.membershipId === m && c.balance === r.membership.balance));
  });

  it('los eventos que no afectan pases se despachan sin generar trabajo', async () => {
    await emit('customer.registered', both);
    expect(
      await dispatchOutboxBatch(handle.db, async () => {
        throw new Error('no debería encolar');
      }),
    ).toBe(1);
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

describe('vencimientos programados', () => {
  it('el worker programa el trabajo cada hora', async () => {
    const schedules = await worker.boss.getSchedules(EXPIRATION_QUEUE);
    expect(schedules.map((x) => x.cron)).toEqual([EXPIRATION_CRON]);
  });

  it('cada negocio vence sus premios a las 3:00 de SU zona horaria, una sola vez y avisando a Wallet', async () => {
    const lima = await createTestOrg(handle.db, { mode: 'stamps', goal: 2 });
    const tokyo = await createTestOrg(handle.db, { mode: 'stamps', goal: 2 });
    await withSystemTx(handle.db, (tx) =>
      tx
        .update(schema.organizations)
        .set({ timezone: 'Asia/Tokyo' })
        .where(eq(schema.organizations.id, tokyo.orgId)),
    );
    const earnedAt = new Date('2026-09-01T15:00:00Z');
    const reach = async (org: typeof lima) => {
      const m = await org.newMembership();
      for (let i = 0; i < 2; i++)
        await earn(handle.db, org.orgId, {
          membershipId: m,
          operator: org.owner,
          idempotencyKey: `exp_${randomUUID()}`,
          now: new Date(earnedAt.getTime() + i * 5 * 3_600_000), // fuera del cooldown
        });
      return m;
    };
    const mLima = await reach(lima);
    const mTokyo = await reach(tokyo);
    const status = (m: string) =>
      withSystemTx(handle.db, (tx) =>
        tx
          .select({ status: schema.earnedRewards.status })
          .from(schema.earnedRewards)
          .where(eq(schema.earnedRewards.membershipId, m)),
      ).then((r) => r.map((x) => x.status));
    expect(await status(mLima)).toEqual(['available']);

    // 31 días después (vigencia 30), 08:30 UTC = 3:30 en Lima y 17:30 en Tokio.
    const now = new Date('2026-10-10T08:30:00Z');
    const run = await runScheduledExpirations(handle.db, now);
    expect(run.failed).toBe(0);
    expect(await status(mLima)).toEqual(['expired']);
    expect(await status(mTokyo)).toEqual(['available']); // en Tokio no son las 3:00
    const events = await withSystemTx(handle.db, (tx) =>
      tx
        .select({ type: schema.eventOutbox.type })
        .from(schema.eventOutbox)
        .where(eq(schema.eventOutbox.aggregateId, mLima)),
    );
    expect(events.map((e) => e.type)).toContain('reward.expired');

    // Reintento de la misma hora: no vuelve a vencer ni a avisar.
    const before = events.length;
    await runScheduledExpirations(handle.db, now);
    const after = await withSystemTx(handle.db, (tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.eventOutbox)
        .where(eq(schema.eventOutbox.aggregateId, mLima)),
    );
    expect(after[0]!.n).toBe(before);

    // 18:30 UTC = 3:30 del 11/10 en Tokio: ahora le toca a Tokio.
    await runScheduledExpirations(handle.db, new Date('2026-10-10T18:30:00Z'));
    expect(await status(mTokyo)).toEqual(['expired']);
  });
});
