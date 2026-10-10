/* eslint-disable @typescript-eslint/no-explicit-any -- test: respuestas JSON dinámicas de la API */
/**
 * Semana 6 por HTTP: reportes (medidos antes y después de un recorrido real), exportación CSV
 * auditada, PDF de mostrador y mensajes automáticos según el plan.
 */
import { createDb, schema, withSystemTx, type DbHandle } from '@aiment/db';
import { SEED } from '@aiment/db/seed-data';
import { hashToken } from '@aiment/enrollment';
import { MemoryMailer } from '@aiment/mail';
import { MemoryStorage } from '@aiment/storage';
import { randomInt, randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { SignJWT } from 'jose';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApp, type App } from './app';
import { createSupabaseVerifier } from './auth/verifier';

const SUPABASE_URL = 'http://127.0.0.1:54321';
const JWT_SECRET = 'test-secret-with-at-least-32-characters!!';
const A = SEED.orgs.barberia; // plan Pro
const C = SEED.orgs.veterinaria; // plan Start (sin automatizaciones)

let handle: DbHandle;
let app: App;
let ip = 0;

async function jwt(userId: string) {
  return new SignJWT({ role: 'authenticated', aal: 'aal1' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(`${SUPABASE_URL}/auth/v1`)
    .setAudience('authenticated')
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(JWT_SECRET));
}

async function req(method: string, path: string, opts: { user?: string; body?: unknown; target?: App } = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-forwarded-for': `10.7.${Math.floor(++ip / 250)}.${ip % 250}`,
    'idempotency-key': `rep_${randomUUID().replaceAll('-', '')}`,
  };
  if (opts.user) headers.authorization = `Bearer ${await jwt(opts.user)}`;
  const res = await (opts.target ?? app).request(path, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* CSV o PDF */
  }
  return { status: res.status, json, text, bytes, headers: res.headers };
}

const phone = () => `9${randomInt(10_000_000, 99_999_999)}`;

/** Cliente registrado por el flujo público, desde el QR/NFC del local. */
async function register(channel: 'qr' | 'nfc', name: string, acceptMarketing = false) {
  const go = await req('GET', `/go/${A.linkSlug}?c=${channel === 'nfc' ? 'n' : 'q'}`);
  const visitId = new URL(go.headers.get('location')!, 'http://x').searchParams.get('v');
  const p = phone();
  const r = await req('POST', '/v1/public/register', {
    body: {
      code: A.linkSlug,
      fullName: name,
      phone: p,
      acceptTerms: true,
      acceptPrivacy: true,
      acceptMarketing,
      channel,
      ...(visitId ? { visitId: Number(visitId) } : {}),
    },
  });
  expect(r.status).toBe(201);
  const [m] = await withSystemTx(handle.db, (tx) =>
    tx
      .select({ id: schema.memberships.id, code: schema.memberships.shortCode })
      .from(schema.memberships)
      .where(eq(schema.memberships.webCardTokenHash, hashToken(r.json.webCardToken))),
  );
  return { membershipId: m!.id, shortCode: m!.code, phone: p, webCardToken: r.json.webCardToken as string };
}

const owner = A.owner.id;
const base = `/v1/orgs/${A.id}`;

beforeAll(() => {
  handle = createDb(inject('apiDbUrl'), { max: 6 });
  app = createApp({
    db: handle.db,
    verifier: createSupabaseVerifier({ supabaseUrl: SUPABASE_URL, jwtSecret: JWT_SECRET }),
    config: { requireSuperadminMfa: false, publicBaseUrl: 'http://localhost:5173', trustProxy: true },
    mailer: new MemoryMailer(),
    storage: new MemoryStorage(),
  });
});
afterAll(() => handle?.close());

describe('reportes', () => {
  it('cuentan altas por canal, escaneos, visitas, clientes que volvieron, premios y actividad por persona', async () => {
    const before = (await req('GET', `${base}/reports?days=7`, { user: owner })).json;
    expect(before.period).toMatchObject({ days: 7, timezone: 'America/Lima' });

    const nfc = await register('nfc', 'Reporte Nfc');
    await register('qr', 'Reporte Qr');
    // 2 visitas de la misma clienta (la 2.ª con excepción de límite del dueño) y una visita anulada.
    const earn = (m: string, b: unknown = {}) =>
      req('POST', `${base}/memberships/${m}/earn`, { user: owner, body: b });
    expect((await earn(nfc.membershipId)).status).toBe(201);
    expect((await earn(nfc.membershipId, { overrideReason: 'Vino dos veces hoy' })).status).toBe(201);
    const voided = await earn(nfc.membershipId, { overrideReason: 'Prueba de anulación' });
    expect(
      (
        await req('POST', `${base}/ledger/${voided.json.entries[0].id}/void`, {
          user: owner,
          body: { reason: 'Me equivoqué de cliente' },
        })
      ).status,
    ).toBe(201);
    // Meta (10): quedan 2 sellos tras la anulación; +7 cargados = 9; la próxima visita completa → premio.
    await req('POST', `${base}/memberships/${nfc.membershipId}/adjust`, {
      user: owner,
      body: { delta: 7, reason: 'Migración de tarjeta física' },
    });
    const goal = await earn(nfc.membershipId, { overrideReason: 'Completa la tarjeta' });
    const reward = goal.json.earnedRewards.find((r: any) => r.source === 'goal');
    expect(reward).toBeTruthy();
    expect(
      (
        await req('POST', `${base}/memberships/${nfc.membershipId}/redeem`, {
          user: owner,
          body: { earnedRewardId: reward.id },
        })
      ).status,
    ).toBe(201);

    const after = (await req('GET', `${base}/reports?days=7`, { user: owner })).json;
    const d = (f: (r: any) => number) => f(after) - f(before);
    expect(d((r) => r.signups.byChannel.nfc)).toBe(1);
    expect(d((r) => r.signups.byChannel.qr)).toBe(1);
    expect(d((r) => r.signups.total)).toBe(2);
    expect(d((r) => r.scans.byChannel.nfc)).toBe(1);
    expect(d((r) => r.scans.converted)).toBe(2);
    expect(d((r) => r.visits.total)).toBe(3); // la anulada no cuenta
    expect(d((r) => r.visits.returningCustomers)).toBe(1);
    expect(d((r) => r.rewards.earnedGoal)).toBe(1);
    expect(d((r) => r.rewards.redeemed)).toBe(1);
    const pedro = (r: any) => r.staff.find((s: any) => s.id === A.owner.orgUserId);
    expect(d((r) => pedro(r).visits)).toBe(3);
    expect(d((r) => pedro(r).voids)).toBe(1);
    expect(d((r) => pedro(r).overrides)).toBe(3);
    expect(d((r) => pedro(r).redemptions)).toBe(1);
    expect(after.visits.byDay.length).toBeGreaterThan(0);
    // Sin datos personales en el reporte.
    expect(JSON.stringify(after)).not.toContain(nfc.phone);
    expect(JSON.stringify(after)).not.toContain('Reporte Nfc');
  });

  it('período inválido → 400; el admin ve reportes; otro negocio → 404', async () => {
    expect((await req('GET', `${base}/reports?days=15`, { user: owner })).status).toBe(400);
    expect((await req('GET', `${base}/reports`, { user: A.admin.id })).status).toBe(200);
    expect((await req('GET', `${base}/reports`, { user: C.owner.id })).status).toBe(404);
  });
});

describe('exportación CSV', () => {
  it('clientes: Excel-friendly, con aceptación de promociones; queda auditado sin datos personales', async () => {
    const c = await register('qr', 'Exporta Ñandú', true);
    const r = await req('GET', `${base}/exports/customers.csv`, { user: owner });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(r.headers.get('content-disposition')).toMatch(
      /^attachment; filename="clientes-barberia-pedro-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect([...r.bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM UTF-8
    const lines = r.text
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
    expect(lines[0]).toBe(
      'Nombre,Celular,Correo,Cumpleaños,Código de tarjeta,Estado,Saldo,Visitas,Premios por canjear,Premios canjeados,Acepta promociones,Canal de registro,Cliente desde,Última actividad',
    );
    const row = lines.find((l) => l.startsWith('Exporta Ñandú,'))!;
    const p = c.phone;
    expect(row).toContain(`,${p.slice(0, 3)} ${p.slice(3, 6)} ${p.slice(6)},`); // 987 654 321
    expect(row).toContain(`,${c.shortCode},Activo,0,0,0,0,Sí,QR,`);

    const [log] = await withSystemTx(handle.db, (tx) =>
      tx
        .select()
        .from(schema.auditLogs)
        .where(
          and(eq(schema.auditLogs.organizationId, A.id), eq(schema.auditLogs.action, 'customers.exported')),
        )
        .orderBy(desc(schema.auditLogs.createdAt))
        .limit(1),
    );
    expect(log).toMatchObject({ actorId: A.owner.orgUserId });
    expect(log!.after).toEqual({ kind: 'customers', rows: lines.length - 1 });
  });

  it('movimientos del período: con el código de la tarjeta, sin nombre ni celular', async () => {
    const c = await register('nfc', 'Movimiento Privado');
    await req('POST', `${base}/memberships/${c.membershipId}/earn`, { user: owner, body: {} });
    const r = await req('GET', `${base}/exports/movements.csv?days=7`, { user: owner });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-disposition')).toContain('movimientos-barberia-pedro-7d-');
    const row = r.text.split('\r\n').find((l) => l.includes(`,${c.shortCode},`))!;
    expect(row).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2},Visita \/ compra,1,1,,/);
    expect(row).toContain(',Pedro Ramos,');
    expect(r.text).not.toContain('Movimiento Privado');
    expect(r.text).not.toContain(c.phone);
  });

  it('límite de exportaciones por persona y plan sin CSV → 409', async () => {
    const strict = createApp({
      db: handle.db,
      verifier: createSupabaseVerifier({ supabaseUrl: SUPABASE_URL, jwtSecret: JWT_SECRET }),
      config: { requireSuperadminMfa: false, rateLimits: { export: 2 } },
    });
    const statuses = [];
    for (let i = 0; i < 3; i++)
      statuses.push(
        (await req('GET', `${base}/exports/customers.csv`, { user: owner, target: strict })).status,
      );
    expect(statuses).toEqual([200, 200, 429]);

    await withSystemTx(handle.db, (tx) =>
      tx.insert(schema.orgFeatureOverrides).values({ organizationId: C.id, feature: 'csv', value: false }),
    );
    try {
      const r = await req('GET', `/v1/orgs/${C.id}/exports/customers.csv`, { user: C.owner.id });
      expect([r.status, r.json.error.code]).toEqual([409, 'plan_feature']);
    } finally {
      await withSystemTx(handle.db, (tx) =>
        tx
          .delete(schema.orgFeatureOverrides)
          .where(
            and(
              eq(schema.orgFeatureOverrides.organizationId, C.id),
              eq(schema.orgFeatureOverrides.feature, 'csv'),
            ),
          ),
      );
    }
  });
});

describe('ficha del cliente (bug encontrado en la semana 6)', () => {
  it('quien aceptó promociones figura como "Acepta" en el panel (antes siempre decía "No acepta")', async () => {
    const yes = await register('qr', 'Acepta Promos', true);
    const no = await register('qr', 'Sin Promos', false);
    const customerOf = async (membershipId: string) => {
      const [m] = await withSystemTx(handle.db, (tx) =>
        tx
          .select({ customerId: schema.memberships.customerId })
          .from(schema.memberships)
          .where(eq(schema.memberships.id, membershipId)),
      );
      return (await req('GET', `${base}/customers/${m!.customerId}`, { user: owner })).json;
    };
    expect((await customerOf(yes.membershipId)).marketing).toBe(true);
    expect((await customerOf(no.membershipId)).marketing).toBe(false);
  });
});

describe('PDF de mostrador', () => {
  it('un PDF A5 de una página por sucursal, listo para imprimir', async () => {
    const r = await req('GET', `${base}/branches/${A.branchId}/counter.pdf`, { user: owner });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/pdf');
    expect(r.headers.get('content-disposition')).toBe(
      'attachment; filename="mostrador-barberia-pedro-sede-principal.pdf"',
    );
    expect(new TextDecoder().decode(r.bytes.slice(0, 5))).toBe('%PDF-');
    const pdf = await PDFDocument.load(r.bytes);
    expect(pdf.getPageCount()).toBe(1);
    expect(pdf.getTitle()).toBe('Barbería Pedro — Sede principal');
    const { width, height } = pdf.getPage(0).getSize();
    expect([Math.round(width), Math.round(height)]).toEqual([420, 595]);
  });

  it('sucursal de otro negocio o mal formada → 404', async () => {
    expect((await req('GET', `${base}/branches/${C.branchId}/counter.pdf`, { user: owner })).status).toBe(
      404,
    );
    expect((await req('GET', `${base}/branches/no-es-uuid/counter.pdf`, { user: owner })).status).toBe(404);
  });
});

describe('mensajes automáticos por HTTP', () => {
  it('plan Pro: disponibles y configurables; plan Start: se ven pero no se activan', async () => {
    const pro = await req('GET', `${base}/automations`, { user: owner });
    expect(pro.json).toMatchObject({ available: true, mode: 'stamps' });
    expect(pro.json.automations.map((a: any) => a.key)).toEqual(['welcome', 'goal_reached', 'almost_there']);
    const start = await req('GET', `/v1/orgs/${C.id}/automations`, { user: C.owner.id });
    expect(start.json.available).toBe(false);
    const denied = await req('PATCH', `/v1/orgs/${C.id}/automations/welcome`, {
      user: C.owner.id,
      body: { enabled: false },
    });
    expect([denied.status, denied.json.error.code]).toEqual([409, 'plan_feature']);
  });

  it('1.ª visita que además completa la meta: la tarjeta muestra el premio, no la bienvenida (bug de la semana 6)', async () => {
    const c = await register('qr', 'Primera Con Premio');
    await req('POST', `${base}/memberships/${c.membershipId}/adjust`, {
      user: owner,
      body: { delta: 9, reason: 'Migración de tarjeta física' },
    });
    await req('POST', `${base}/memberships/${c.membershipId}/earn`, { user: owner, body: {} });
    const card = (await req('GET', `/v1/public/cards/${c.webCardToken}`)).json;
    expect(card.message.key).toBe('goal_reached');
  });

  it('la tarjeta del cliente muestra el mensaje vigente: bienvenida en la 1.ª visita', async () => {
    const c = await register('qr', 'Mensaje Tarjeta');
    expect((await req('GET', `/v1/public/cards/${c.webCardToken}`)).json.message).toBeNull();
    await req('POST', `${base}/memberships/${c.membershipId}/earn`, { user: owner, body: {} });
    const card = (await req('GET', `/v1/public/cards/${c.webCardToken}`)).json;
    expect(card.message).toEqual({
      key: 'welcome',
      text: '¡Gracias por tu primera visita! Ya empezaste a juntar sellos.',
    });
  });
});
