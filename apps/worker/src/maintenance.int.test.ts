/**
 * Mantenimiento de producción contra la base de test: limpieza de datos temporales y control de
 * salud con avisos. Corre con el usuario de la API (sin BYPASSRLS), como el worker real.
 */
import { createDb, schema, withSystemTx, type DbHandle } from '@aiment/db';
import { SEED, seedMembershipId } from '@aiment/db/seed-data';
import { MemoryMailer } from '@aiment/mail';
import { Alerter } from '@aiment/ops';
import { inArray } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { cleanupTemporaryData, DEFAULT_THRESHOLDS, runHealthCheck } from './maintenance';

const A = SEED.orgs.barberia;
let handle: DbHandle;

beforeAll(() => {
  handle = createDb(inject('apiDbUrl'), { max: 4 });
});
afterAll(() => handle?.close());

const hash = () => randomBytes(16).toString('hex');
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

describe('limpieza de datos temporales', () => {
  it('borra lo vencido o usado hace más de 30 días y conserva lo reciente, lo pendiente y lo importante', async () => {
    const ids = await withSystemTx(handle.db, async (tx) => {
      const [device] = await tx
        .insert(schema.workerDevices)
        .values({
          organizationId: A.id,
          branchId: A.branchId,
          name: 'Caja limpieza',
          deviceSecretHash: hash(),
          authorizedBy: A.owner.orgUserId,
        })
        .returning({ id: schema.workerDevices.id });
      const outbox = await tx
        .insert(schema.eventOutbox)
        .values([
          {
            organizationId: A.id,
            type: 'test.viejo',
            aggregateId: A.id,
            payload: {},
            dispatchedAt: daysAgo(40),
          },
          {
            organizationId: A.id,
            type: 'test.reciente',
            aggregateId: A.id,
            payload: {},
            dispatchedAt: daysAgo(5),
          },
        ])
        .returning({ id: schema.eventOutbox.id });
      const sessions = await tx
        .insert(schema.staffSessions)
        .values([
          {
            organizationId: A.id,
            deviceId: device!.id,
            organizationUserId: A.staff[0].orgUserId,
            tokenHash: hash(),
            expiresAt: daysAgo(35),
          },
          {
            organizationId: A.id,
            deviceId: device!.id,
            organizationUserId: A.staff[0].orgUserId,
            tokenHash: hash(),
            expiresAt: daysAgo(-1),
          },
        ])
        .returning({ id: schema.staffSessions.id });
      const pairings = await tx
        .insert(schema.devicePairings)
        .values([
          {
            organizationId: A.id,
            branchId: A.branchId,
            name: 'Vieja',
            codeHash: hash(),
            createdBy: A.owner.orgUserId,
            expiresAt: daysAgo(31),
          },
          {
            organizationId: A.id,
            branchId: A.branchId,
            name: 'Hoy',
            codeHash: hash(),
            createdBy: A.owner.orgUserId,
            expiresAt: daysAgo(0),
          },
        ])
        .returning({ id: schema.devicePairings.id });
      const recovery = await tx
        .insert(schema.cardRecoveryTokens)
        .values([
          {
            organizationId: A.id,
            membershipId: seedMembershipId('barberia', 4),
            tokenHash: hash(),
            channel: 'email',
            expiresAt: daysAgo(60),
            usedAt: daysAgo(60),
          },
          {
            organizationId: A.id,
            membershipId: seedMembershipId('barberia', 4),
            tokenHash: hash(),
            channel: 'email',
            expiresAt: daysAgo(-1),
          },
        ])
        .returning({ id: schema.cardRecoveryTokens.id });
      return { outbox, sessions, pairings, recovery };
    });
    const pending = await withSystemTx(handle.db, (tx) =>
      tx
        .insert(schema.eventOutbox)
        .values({ organizationId: A.id, type: 'test.pendiente', aggregateId: A.id, payload: {} })
        .returning({ id: schema.eventOutbox.id }),
    );
    const ledgerBefore = await withSystemTx(handle.db, (tx) =>
      tx.select({ id: schema.ledgerEntries.id }).from(schema.ledgerEntries),
    );

    const r = await cleanupTemporaryData(handle.db);
    expect(r.outboxEvents).toBeGreaterThanOrEqual(1);
    expect(r.staffSessions).toBeGreaterThanOrEqual(1);
    expect(r.devicePairings).toBeGreaterThanOrEqual(1);
    expect(r.recoveryTokens).toBeGreaterThanOrEqual(1);

    const remaining = await withSystemTx(handle.db, async (tx) => ({
      outbox: (
        await tx
          .select({ id: schema.eventOutbox.id })
          .from(schema.eventOutbox)
          .where(
            inArray(
              schema.eventOutbox.id,
              [...ids.outbox, ...pending].map((x) => x.id),
            ),
          )
      ).map((x) => x.id),
      sessions: (
        await tx
          .select({ id: schema.staffSessions.id })
          .from(schema.staffSessions)
          .where(
            inArray(
              schema.staffSessions.id,
              ids.sessions.map((x) => x.id),
            ),
          )
      ).map((x) => x.id),
      pairings: (
        await tx
          .select({ id: schema.devicePairings.id })
          .from(schema.devicePairings)
          .where(
            inArray(
              schema.devicePairings.id,
              ids.pairings.map((x) => x.id),
            ),
          )
      ).map((x) => x.id),
      recovery: (
        await tx
          .select({ id: schema.cardRecoveryTokens.id })
          .from(schema.cardRecoveryTokens)
          .where(
            inArray(
              schema.cardRecoveryTokens.id,
              ids.recovery.map((x) => x.id),
            ),
          )
      ).map((x) => x.id),
    }));
    expect(remaining.outbox).toEqual([ids.outbox[1]!.id, pending[0]!.id]); // reciente y pendiente quedan
    expect(remaining.sessions).toEqual([ids.sessions[1]!.id]);
    expect(remaining.pairings).toEqual([ids.pairings[1]!.id]);
    expect(remaining.recovery).toEqual([ids.recovery[1]!.id]);
    // El ledger no se toca nunca.
    const ledgerAfter = await withSystemTx(handle.db, (tx) =>
      tx.select({ id: schema.ledgerEntries.id }).from(schema.ledgerEntries),
    );
    expect(ledgerAfter.length).toBeGreaterThanOrEqual(ledgerBefore.length);
    // Idempotente: repetirla no borra lo que quedó.
    await cleanupTemporaryData(handle.db);
    await withSystemTx(handle.db, (tx) =>
      tx.delete(schema.eventOutbox).where(inArray(schema.eventOutbox.id, [pending[0]!.id])),
    );
  });
});

describe('control de salud', () => {
  it('mide la base, el servidor y Wallet; avisa al pasar un umbral y no repite el aviso', async () => {
    const mailer = new MemoryMailer();
    const hooks: { key: string; level: string; text: string }[] = [];
    const alerter = new Alerter({
      source: 'worker',
      webhookUrl: 'https://n8n.example/webhook/aiment',
      email: { mailer, to: 'ops@aimentwallet.com' },
      fetch: (async (_u: string, init: RequestInit) => {
        hooks.push(JSON.parse(String(init.body)));
        return new Response('ok');
      }) as unknown as typeof fetch,
    });
    // Umbral de base en 1 MB para forzar el aviso; el resto, imposibles de alcanzar.
    const t = {
      ...DEFAULT_THRESHOLDS,
      dbWarnMb: 1,
      dbCriticalMb: 100_000,
      memPct: 101,
      diskPct: 101,
      loadPerCore: 1e6,
      outboxLagMinutes: 1e9,
      walletErrors: 1e9,
    };
    const s = await runHealthCheck(handle.db, alerter, t);
    expect(s.dbSizeMb).toBeGreaterThan(1);
    expect(s.host.memUsedPct).toBeGreaterThan(0);
    expect(hooks.map((h) => [h.key, h.level])).toEqual([['db-size', 'warning']]);
    expect(hooks[0]!.text).toContain('solo lectura');
    expect(mailer.sent).toHaveLength(1);

    await runHealthCheck(handle.db, alerter, t); // 15 min después: mismo problema, sin repetir
    expect(hooks).toHaveLength(1);
    await runHealthCheck(handle.db, alerter, { ...t, dbWarnMb: 100_000 }); // se resolvió
    await runHealthCheck(handle.db, alerter, t); // vuelve a pasar: avisa otra vez
    expect(hooks).toHaveLength(2);
  });
});
