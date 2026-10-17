/**
 * Google Wallet (simulado) de punta a punta contra la base real: enlace desde la tarjeta →
 * operaciones de caja → outbox → cola de Google → pase actualizado. El proveedor es el mismo
 * código que en modo real; solo la API de Google es la simulada.
 */
import { createDb, schema, withSystemTx, type DbHandle } from '@aiment/db';
import { adjust, earn, redeem, voidEntry } from '@aiment/ledger';
import { createTestOrg, type TestOrg } from '@aiment/ledger/test-fixtures';
import {
  FakeWalletProvider,
  googleClassId,
  GoogleWalletProvider,
  requestWalletLink,
  SimulatedGoogleWalletApi,
  type LoyaltyClass,
  type LoyaltyObject,
} from '@aiment/wallet';
import { and, eq, sql } from 'drizzle-orm';
import { decodeJwt, exportPKCS8, generateKeyPair } from 'jose';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { startWorker } from './boss';

const BASE = 'http://localhost:5173';
const ISSUER = '3388000000000000000';

let handle: DbHandle;
let worker: Awaited<ReturnType<typeof startWorker>>;
let google: GoogleWalletProvider;
const api = new SimulatedGoogleWalletApi();
const logs: string[] = [];

beforeAll(async () => {
  handle = createDb(inject('apiDbUrl'), { max: 6 });
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  google = new GoogleWalletProvider({
    mode: 'simulated',
    issuerId: ISSUER,
    serviceAccount: { client_email: 'sim@aiment.local', private_key: await exportPKCS8(privateKey) },
    api,
    publicBaseUrl: BASE,
  });
  worker = await startWorker({
    databaseUrl: inject('apiDbUrl'),
    db: handle.db,
    // Igual que el worker local: Google simulado + el simulado viejo para los pases de la semilla.
    providers: [google, new FakeWalletProvider('google'), new FakeWalletProvider('apple')],
    publicBaseUrl: BASE,
    debounceSeconds: 0,
    retry: { limit: 5, delaySeconds: 1, backoff: false },
    pollSeconds: 0.5,
    autoDispatch: false,
    scheduleExpirations: false,
    log: (m) => logs.push(m),
  });
});

afterAll(async () => {
  await worker?.stop();
  await handle?.close();
});

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await worker.tick();
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('waitFor: tiempo agotado');
}

const key = () => `gw_${randomUUID().replaceAll('-', '')}`;
const jwtPayload = (url: string) =>
  (
    decodeJwt(url.split('#')[1]!) as {
      payload: { loyaltyClasses: LoyaltyClass[]; loyaltyObjects: LoyaltyObject[] };
    }
  ).payload;

/** El cliente toca "Agregar a Google Wallet" y luego "Guardar" en su Android. */
async function savePass(membershipId: string) {
  const r = await requestWalletLink(handle.db, google, membershipId, BASE);
  if (r.status !== 'ok') throw new Error(`enlace: ${r.status}`);
  api.saveFromJwt(jwtPayload(r.addUrl));
  return r;
}

const dbState = (membershipId: string) =>
  withSystemTx(handle.db, async (tx) => {
    const [m] = await tx
      .select({ balance: schema.memberships.balance })
      .from(schema.memberships)
      .where(eq(schema.memberships.id, membershipId));
    const [r] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.earnedRewards)
      .where(
        and(
          eq(schema.earnedRewards.membershipId, membershipId),
          eq(schema.earnedRewards.status, 'available'),
        ),
      );
    return { balance: m!.balance, rewards: r!.n };
  });

const passRow = (membershipId: string) =>
  withSystemTx(handle.db, (tx) =>
    tx
      .select()
      .from(schema.walletPasses)
      .where(
        and(eq(schema.walletPasses.membershipId, membershipId), eq(schema.walletPasses.provider, 'google')),
      ),
  );

const object = (id: string) => api.objects.get(id) as LoyaltyObject | undefined;

/** El pase en Google muestra exactamente lo que dice la base (saldo y premios). */
async function passMatchesDb(membershipId: string, objectId: string) {
  await waitFor(async () => {
    const db = await dbState(membershipId);
    const o = object(objectId);
    return o?.loyaltyPoints.balance.int === db.balance && o.secondaryLoyaltyPoints.balance.int === db.rewards;
  });
  return dbState(membershipId);
}

describe('Google Wallet simulado: el pase sigue a la caja', () => {
  let org: TestOrg;
  beforeAll(async () => {
    org = await createTestOrg(handle.db, { mode: 'stamps', goal: 3 });
  });

  it('sumar, completar la meta, canjear, ajustar y anular: el pase siempre muestra el saldo de la base', async () => {
    const m = await org.newMembership();
    const { externalId } = await savePass(m);
    expect(object(externalId)!.loyaltyPoints.balance.int).toBe(0);

    // Tres visitas (fuera del tiempo mínimo entre visitas) → meta cumplida y premio disponible.
    const start = Date.now() - 20 * 3_600_000;
    for (let i = 0; i < 3; i++)
      await earn(handle.db, org.orgId, {
        membershipId: m,
        operator: org.staff,
        idempotencyKey: key(),
        now: new Date(start + i * 5 * 3_600_000),
      });
    expect(await passMatchesDb(m, externalId)).toMatchObject({ rewards: 1 });

    const [reward] = await withSystemTx(handle.db, (tx) =>
      tx
        .select({ id: schema.earnedRewards.id })
        .from(schema.earnedRewards)
        .where(and(eq(schema.earnedRewards.membershipId, m), eq(schema.earnedRewards.status, 'available'))),
    );
    await redeem(handle.db, org.orgId, {
      membershipId: m,
      earnedRewardId: reward!.id,
      operator: org.staff,
      idempotencyKey: key(),
    });
    expect(await passMatchesDb(m, externalId)).toMatchObject({ rewards: 0 });

    const adj = await adjust(handle.db, org.orgId, {
      membershipId: m,
      delta: 2,
      reason: 'Visitas no registradas',
      operator: org.owner,
      idempotencyKey: key(),
    });
    expect((await passMatchesDb(m, externalId)).balance).toBe(adj.membership.balance);

    await voidEntry(handle.db, org.orgId, {
      entryId: adj.entries[0]!.id,
      reason: 'Ajuste por error',
      operator: org.owner,
      idempotencyKey: key(),
    });
    await passMatchesDb(m, externalId);
    const [row] = await passRow(m);
    expect(row).toMatchObject({ status: 'active', lastError: null, issuerRef: `google-sim:${ISSUER}` });
    expect(row!.passVersion).toBeGreaterThan(1);
  });

  it('si el cliente abrió el enlace pero no guardó, el pase se crea en Google con el saldo al día', async () => {
    const m = await org.newMembership();
    const r = await requestWalletLink(handle.db, google, m, BASE);
    if (r.status !== 'ok') throw new Error(r.status);
    expect(object(r.externalId)).toBeUndefined();
    await earn(handle.db, org.orgId, { membershipId: m, operator: org.staff, idempotencyKey: key() });
    expect((await passMatchesDb(m, r.externalId)).balance).toBe(1);
  });

  it('Google caído: la caja suma igual, el ledger queda bien y el pase se pone al día al volver', async () => {
    const m = await org.newMembership();
    const { externalId } = await savePass(m);
    api.down = true;
    try {
      const r = await earn(handle.db, org.orgId, {
        membershipId: m,
        operator: org.staff,
        idempotencyKey: key(),
      });
      expect(r.membership.balance).toBe(1); // la caja no espera a Google
      await waitFor(async () => (await passRow(m))[0]!.lastError?.includes('no disponible') ?? false);
      expect(object(externalId)!.loyaltyPoints.balance.int).toBe(0);
      expect((await dbState(m)).balance).toBe(1);
    } finally {
      api.down = false;
    }
    await passMatchesDb(m, externalId);
    await waitFor(async () => (await passRow(m))[0]!.lastError === null);
  });

  it('un rechazo de Google por datos o permisos queda registrado y no se reintenta en bucle', async () => {
    const m = await org.newMembership();
    const { externalId } = await savePass(m);
    const callsBefore = api.calls.filter((c) => c.id === externalId).length;
    api.failNext(1, 403);
    await earn(handle.db, org.orgId, { membershipId: m, operator: org.staff, idempotencyKey: key() });
    await waitFor(async () => (await passRow(m))[0]!.lastError?.includes('403') ?? false);
    await new Promise((r) => setTimeout(r, 2500)); // más que el retraso de reintento
    expect(api.calls.filter((c) => c.id === externalId).length).toBe(callsBefore + 1);
    expect(logs.some((l) => l.includes('no se reintenta'))).toBe(true);
  });

  it('tarjeta pausada: el pase guardado pierde el QR; al reactivarla lo recupera', async () => {
    const m = await org.newMembership();
    const { externalId } = await savePass(m);
    const setStatus = async (status: 'active' | 'blocked') =>
      withSystemTx(handle.db, async (tx) => {
        await tx.update(schema.memberships).set({ status }).where(eq(schema.memberships.id, m));
        await tx.insert(schema.eventOutbox).values({
          organizationId: org.orgId,
          type: 'membership.updated',
          aggregateId: m,
          payload: { status },
        });
      });
    await setStatus('blocked');
    await waitFor(() => object(externalId)!.barcode.type === 'TEXT_ONLY');
    expect(object(externalId)!.barcode.value).toBe('Tarjeta pausada');
    // Pausada: no se entrega un enlace nuevo con QR.
    expect((await requestWalletLink(handle.db, google, m, BASE)).status).toBe('blocked');
    await setStatus('active');
    await waitFor(() => object(externalId)!.barcode.type === 'QR_CODE');
  });

  it('cliente eliminado: el pase queda inactivo en Google, sin nombre ni QR', async () => {
    const m = await org.newMembership();
    const { externalId } = await savePass(m);
    expect(object(externalId)!.accountName).toMatch(/^Cliente/);
    // Lo mismo que hace la baja del cliente (anonymizeCustomer): membresía cerrada, pases revocados, evento.
    await withSystemTx(handle.db, async (tx) => {
      await tx.update(schema.memberships).set({ status: 'closed' }).where(eq(schema.memberships.id, m));
      await tx
        .update(schema.walletPasses)
        .set({ status: 'revoked' })
        .where(eq(schema.walletPasses.membershipId, m));
      await tx
        .insert(schema.eventOutbox)
        .values({ organizationId: org.orgId, type: 'membership.closed', aggregateId: m, payload: {} });
    });
    await waitFor(() => object(externalId)!.state === 'INACTIVE');
    const o = object(externalId)!;
    expect(o.accountName).toBe('Tarjeta cerrada');
    expect(o.barcode).toEqual({ type: 'TEXT_ONLY', value: 'Tarjeta cerrada' });
    expect(JSON.stringify(o)).not.toContain('/s/');
    expect((await requestWalletLink(handle.db, google, m, BASE)).status).toBe('not_found');
  });
});

describe('Google Wallet simulado: un pase por cliente y aislamiento por negocio', () => {
  it('pedir el enlace varias veces (incluso a la vez) da siempre el mismo pase', async () => {
    const org = await createTestOrg(handle.db, { mode: 'points' });
    const m = await org.newMembership();
    const links = await Promise.all([1, 2, 3].map(() => requestWalletLink(handle.db, google, m, BASE)));
    const ids = new Set(links.map((l) => (l.status === 'ok' ? l.externalId : l.status)));
    expect(ids.size).toBe(1);
    expect(await passRow(m)).toHaveLength(1);
  });

  it('cada negocio tiene su propia clase; el pase de un negocio nunca muestra la marca de otro', async () => {
    const a = await createTestOrg(handle.db, { mode: 'stamps', goal: 5 });
    const b = await createTestOrg(handle.db, { mode: 'points' });
    const ma = await a.newMembership();
    const mb = await b.newMembership();
    const la = await requestWalletLink(handle.db, google, ma, BASE);
    const lb = await requestWalletLink(handle.db, google, mb, BASE);
    if (la.status !== 'ok' || lb.status !== 'ok') throw new Error('enlace');
    const pa = jwtPayload(la.addUrl);
    const pb = jwtPayload(lb.addUrl);
    expect(pa.loyaltyClasses[0]!.id).toBe(googleClassId(ISSUER, a.programId));
    expect(pb.loyaltyClasses[0]!.id).toBe(googleClassId(ISSUER, b.programId));
    expect(pa.loyaltyClasses[0]!.issuerName).toBe(`Negocio de prueba ${a.orgId.slice(0, 8)}`);
    expect(JSON.stringify(pa)).not.toContain(b.orgId.slice(0, 8));
    expect(pa.loyaltyObjects[0]!.classId).toBe(pa.loyaltyClasses[0]!.id);
    expect((await passRow(ma))[0]!.organizationId).toBe(a.orgId);
    expect((await passRow(mb))[0]!.organizationId).toBe(b.orgId);
  });

  it('un pase de otra cuenta emisora (migración) queda revocado y se emite uno nuevo', async () => {
    const org = await createTestOrg(handle.db, { mode: 'points' });
    const m = await org.newMembership();
    await withSystemTx(handle.db, (tx) =>
      tx.insert(schema.walletPasses).values({
        organizationId: org.orgId,
        membershipId: m,
        provider: 'google',
        issuerRef: 'google:3388000000099999999',
        externalId: '3388000000099999999.aw_viejo',
      }),
    );
    const r = await requestWalletLink(handle.db, google, m, BASE);
    expect(r.status).toBe('ok');
    const rows = await passRow(m);
    expect(rows.map((x) => [x.issuerRef, x.status]).sort()).toEqual([
      ['google-sim:3388000000000000000', 'active'],
      ['google:3388000000099999999', 'revoked'],
    ]);
  });
});
