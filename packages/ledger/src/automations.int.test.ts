/**
 * Automatizaciones (semana 6) contra PostgreSQL real con el rol de la API (RLS activo):
 * bienvenida, meta alcanzada y "te falta poco", sin duplicados, anulación, plan y panel.
 */
import { createDb, schema, withSystemTx, type DbHandle, type Tx } from '@aiment/db';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { listAutomations, runAutomations, updateAutomation } from './automations';
import { adjust, earn, voidEntry } from './ledger';
import { createTestOrg, type TestOrg } from './test-fixtures';
import { ServiceError } from './types';

let h: DbHandle;
const key = () => `a_${randomUUID().replaceAll('-', '')}`;
const t0 = new Date('2026-10-01T13:00:00Z');
const at = (hours: number) => new Date(t0.getTime() + hours * 3_600_000);

/** Negocio de prueba con automatizaciones habilitadas (override por negocio, como un plan Pro). */
async function orgWithAutomations(opts: Parameters<typeof createTestOrg>[1]): Promise<TestOrg> {
  const org = await createTestOrg(h.db, opts);
  await withSystemTx(h.db, (tx) =>
    tx
      .insert(schema.orgFeatureOverrides)
      .values({ organizationId: org.orgId, feature: 'automations', value: true }),
  );
  return org;
}

const runs = (membershipId: string) =>
  withSystemTx(h.db, (tx) =>
    tx
      .select({ status: schema.automationRuns.status, result: schema.automationRuns.result })
      .from(schema.automationRuns)
      .where(eq(schema.automationRuns.membershipId, membershipId))
      .orderBy(schema.automationRuns.createdAt),
  ).then((r) => r.map((x) => ({ status: x.status, ...(x.result as { key: string; message: string }) })));

const outbox = (membershipId: string, type: string) =>
  withSystemTx(h.db, (tx) =>
    tx
      .select({ payload: schema.eventOutbox.payload })
      .from(schema.eventOutbox)
      .where(and(eq(schema.eventOutbox.aggregateId, membershipId), eq(schema.eventOutbox.type, type))),
  );

beforeAll(() => {
  h = createDb(inject('apiDbUrl'), { max: 10 });
});
afterAll(() => h?.close());

describe('mensajes automáticos en sellos', () => {
  let org: TestOrg;
  beforeAll(async () => {
    org = await orgWithAutomations({ mode: 'stamps', goal: 3, welcomeBonus: { type: 'units', units: 1 } });
  });

  it('1.ª visita con bono: bienvenida y "te falta poco"; 2.ª visita: meta alcanzada; cada uno avisa al outbox', async () => {
    const m = await org.newMembership();
    await earn(h.db, org.orgId, { membershipId: m, operator: org.staff, idempotencyKey: key(), now: at(0) });
    // 1 sello + 1 de bienvenida = 2 de 3 → falta 1.
    expect((await runs(m)).map((r) => [r.key, r.status])).toEqual([
      ['welcome', 'done'],
      ['almost_there', 'done'],
    ]);
    expect((await runs(m))[0]!.message).toContain('Sumaste 1 de regalo');
    expect((await runs(m))[1]!.message).toBe('¡Solo te falta 1 para Premio de meta!');

    await earn(h.db, org.orgId, { membershipId: m, operator: org.staff, idempotencyKey: key(), now: at(5) });
    const all = await runs(m);
    expect(all.map((r) => r.key)).toEqual(['welcome', 'almost_there', 'goal_reached']);
    expect(all[2]!.message).toContain('¡Completaste tu tarjeta! Ganaste: Premio de meta');
    expect(await outbox(m, 'automation.ran')).toHaveLength(3);
  });

  it('reintento con la misma clave (señal débil): no duplica mensajes', async () => {
    const m = await org.newMembership();
    const k = key();
    await earn(h.db, org.orgId, { membershipId: m, operator: org.staff, idempotencyKey: k, now: at(0) });
    await earn(h.db, org.orgId, { membershipId: m, operator: org.staff, idempotencyKey: k, now: at(0) });
    expect(await runs(m)).toHaveLength(2);
  });

  it('anular la visita retira sus mensajes', async () => {
    const m = await org.newMembership();
    await earn(h.db, org.orgId, { membershipId: m, operator: org.staff, idempotencyKey: key(), now: at(0) });
    const second = await earn(h.db, org.orgId, {
      membershipId: m,
      operator: org.staff,
      idempotencyKey: key(),
      now: at(5),
    });
    await voidEntry(h.db, org.orgId, {
      entryId: second.entries[0]!.id,
      reason: 'Me equivoqué de cliente',
      operator: org.owner,
      idempotencyKey: key(),
      now: at(5.1),
    });
    expect((await runs(m)).map((r) => [r.key, r.status])).toEqual([
      ['welcome', 'done'],
      ['almost_there', 'done'],
      ['goal_reached', 'voided'],
    ]);
  });

  it('un ajuste del dueño que completa la meta también avisa', async () => {
    const m = await org.newMembership();
    await adjust(h.db, org.orgId, {
      membershipId: m,
      delta: 3,
      reason: 'Migración de tarjeta física',
      operator: org.owner,
      idempotencyKey: key(),
    });
    expect((await runs(m)).map((r) => r.key)).toEqual(['goal_reached']);
  });

  it('desactivada desde el panel: no hay mensaje; el resto sigue; queda auditado', async () => {
    const other = await orgWithAutomations({ mode: 'stamps', goal: 3 });
    const res = await updateAutomation(h.db, other.orgId, other.owner, 'welcome', { enabled: false });
    expect(res.automations.find((a) => a.key === 'welcome')).toMatchObject({ enabled: false });
    const m = await other.newMembership();
    await earn(h.db, other.orgId, {
      membershipId: m,
      operator: other.staff,
      idempotencyKey: key(),
      now: at(0),
    });
    expect(await runs(m)).toEqual([]); // sin bienvenida; 1 de 3 todavía no es "te falta poco"
    const [log] = await withSystemTx(h.db, (tx) =>
      tx
        .select()
        .from(schema.auditLogs)
        .where(
          and(
            eq(schema.auditLogs.organizationId, other.orgId),
            eq(schema.auditLogs.action, 'automation.updated'),
          ),
        ),
    );
    expect(log!.before).toMatchObject({ key: 'welcome', enabled: true });
    expect(log!.after).toMatchObject({ key: 'welcome', enabled: false });
  });
});

describe('mensajes automáticos en puntos', () => {
  it('ya te alcanza para un premio del catálogo; umbral configurable de "te falta poco"', async () => {
    const org = await orgWithAutomations({ mode: 'points' }); // Café 50, Postre 120
    await updateAutomation(h.db, org.orgId, org.owner, 'almost_there', { threshold: 15 });
    const m = await org.newMembership();
    await earn(h.db, org.orgId, {
      membershipId: m,
      amount: 40,
      operator: org.owner,
      idempotencyKey: key(),
      now: at(0),
    });
    expect((await runs(m)).map((r) => r.key)).toEqual(['welcome', 'almost_there']); // faltan 10 ≤ 15
    await earn(h.db, org.orgId, {
      membershipId: m,
      amount: 20,
      operator: org.owner,
      idempotencyKey: key(),
      now: at(5),
    });
    const all = await runs(m);
    expect(all.at(-1)).toMatchObject({
      key: 'goal_reached',
      message: '¡Ya te alcanza para Café! Pídelo en caja.',
    });
  });
});

describe('plan y configuración', () => {
  it('plan sin automatizaciones: no se ejecutan ni se pueden activar', async () => {
    const org = await createTestOrg(h.db, { mode: 'stamps', goal: 2 }); // plan Start de prueba
    const m = await org.newMembership();
    await earn(h.db, org.orgId, { membershipId: m, operator: org.staff, idempotencyKey: key(), now: at(0) });
    expect(await runs(m)).toEqual([]);
    expect((await listAutomations(h.db, org.orgId)).available).toBe(false);
    await expect(
      updateAutomation(h.db, org.orgId, org.owner, 'welcome', { enabled: true }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'plan_feature',
    });
  });

  it('clave inexistente → 404; umbral solo en "te falta poco"; volver al umbral por defecto', async () => {
    const org = await orgWithAutomations({ mode: 'stamps', goal: 5 });
    await expect(updateAutomation(h.db, org.orgId, org.owner, 'birthday', {})).rejects.toBeInstanceOf(
      ServiceError,
    );
    await expect(
      updateAutomation(h.db, org.orgId, org.owner, 'welcome', { threshold: 2 }),
    ).rejects.toMatchObject({ status: 422 });
    await updateAutomation(h.db, org.orgId, org.owner, 'almost_there', { threshold: 2 });
    const reset = await updateAutomation(h.db, org.orgId, org.owner, 'almost_there', { threshold: null });
    expect(reset.automations.find((a) => a.key === 'almost_there')!.config).toEqual({});
  });

  it('el panel ve cuántos mensajes salieron en los últimos 30 días', async () => {
    const org = await orgWithAutomations({ mode: 'stamps', goal: 10 });
    const m = await org.newMembership();
    await earn(h.db, org.orgId, { membershipId: m, operator: org.staff, idempotencyKey: key() });
    const list = await listAutomations(h.db, org.orgId);
    expect(list).toMatchObject({ available: true, mode: 'stamps' });
    expect(list.automations.find((a) => a.key === 'welcome')!.runsLast30Days).toBe(1);
  });

  it('si una automatización falla, la operación sigue y queda un evento automation.failed', async () => {
    const inserted: { type?: string }[] = [];
    const fakeTx = {
      transaction: async () => {
        throw new Error('fallo simulado');
      },
      insert: () => ({ values: async (v: { type?: string }) => void inserted.push(v) }),
    } as unknown as Tx;
    await runAutomations(fakeTx, {
      orgId: randomUUID(),
      programId: randomUUID(),
      membershipId: randomUUID(),
      mode: 'stamps',
      goal: 3,
      entryId: randomUUID(),
      balanceBefore: 0,
      balanceAfter: 1,
      firstVisit: true,
      welcomeBonus: { type: 'none' },
      goalEarnedRewardIds: [],
      now: new Date(),
    });
    expect(inserted.map((e) => e.type)).toEqual(['automation.failed']);
  });
});
