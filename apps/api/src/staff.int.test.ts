/* eslint-disable @typescript-eslint/no-explicit-any -- test: respuestas JSON dinámicas de la API */
/**
 * Caja por HTTP (semana 4): autorización de dispositivo, turno con PIN, bloqueo por intentos,
 * escaneo y búsqueda, sumar/canjear/anular, excepciones con PIN del dueño, recuperación en caja
 * y aislamiento: un dispositivo solo ve y opera clientes de su propio negocio.
 */
import { createDb, schema, withSystemTx, type DbHandle } from '@aiment/db';
import { SEED, seedMembershipId } from '@aiment/db/seed-data';
import { hashToken } from '@aiment/enrollment';
import { MemoryMailer } from '@aiment/mail';
import { randomInt, randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApp, type App } from './app';
import { createSupabaseVerifier } from './auth/verifier';

const SUPABASE_URL = 'http://127.0.0.1:54321';
const JWT_SECRET = 'test-secret-with-at-least-32-characters!!';
const A = SEED.orgs.barberia;
const B = SEED.orgs.cafe;
const C = SEED.orgs.veterinaria;
const PIN = SEED.pins;

let handle: DbHandle;
let app: App;
let ipCounter = 0;
const freshIp = () => `10.9.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;
const newPhone = () => `9${randomInt(10_000_000, 99_999_999)}`;
const key = () => `caja_${randomUUID().replaceAll('-', '')}`;

/** Navegador mínimo: guarda las cookies que responde la API y las reenvía. */
class Browser {
  cookies = new Map<string, string>();
  lastSetCookie: string[] = [];

  async req(
    method: string,
    path: string,
    opts: { body?: unknown; user?: string; target?: App; headers?: Record<string, string> } = {},
  ) {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-forwarded-for': freshIp(),
      'idempotency-key': key(),
      ...opts.headers,
    };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (opts.user) headers.authorization = `Bearer ${await jwt(opts.user)}`;
    const res = await (opts.target ?? app).request(path, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    this.lastSetCookie = res.headers.getSetCookie();
    for (const c of this.lastSetCookie) {
      const [pair] = c.split(';');
      const [name, value] = pair!.split('=');
      if (!value || /max-age=0/i.test(c)) this.cookies.delete(name!);
      else this.cookies.set(name!, value);
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* sin cuerpo JSON */
    }
    return { status: res.status, json, headers: res.headers };
  }
}

async function jwt(userId: string) {
  return new SignJWT({ role: 'authenticated', aal: 'aal1' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(`${SUPABASE_URL}/auth/v1`)
    .setAudience('authenticated')
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(JWT_SECRET));
}

const owner = new Browser(); // el panel del dueño (sin cookies de caja)

/** El dueño autoriza un dispositivo y el dispositivo abre el QR. */
async function pairDevice(org: { id: string; owner: { id: string } }, name = 'Caja mostrador') {
  const p = await owner.req('POST', `/v1/orgs/${org.id}/devices/pairings`, {
    user: org.owner.id,
    body: { name },
  });
  expect(p.status).toBe(201);
  const code = p.json.url.split('/caja/vincular/')[1];
  const device = new Browser();
  const claim = await device.req('POST', '/v1/staff/device/pair', { body: { code } });
  expect(claim.status).toBe(201);
  return { device, code, pairing: p.json };
}

async function login(device: Browser, personId: string, pin: string) {
  return device.req('POST', '/v1/staff/shift', { body: { personId, pin } });
}

/** Cliente nuevo registrado por el flujo público: devuelve membresía, QR de caja y celular. */
async function newCustomer(code: string = A.linkSlug) {
  const phone = newPhone();
  const r = await owner.req('POST', '/v1/public/register', {
    body: {
      code,
      fullName: 'Cliente Caja',
      phone,
      acceptTerms: true,
      acceptPrivacy: true,
      channel: 'qr',
    },
  });
  expect(r.status).toBe(201);
  const [m] = await withSystemTx(handle.db, (tx) =>
    tx
      .select({
        id: schema.memberships.id,
        scan: schema.memberships.memberScanToken,
        code: schema.memberships.shortCode,
      })
      .from(schema.memberships)
      .where(eq(schema.memberships.webCardTokenHash, hashToken(r.json.webCardToken))),
  );
  return {
    membershipId: m!.id,
    scanToken: m!.scan,
    shortCode: m!.code,
    phone,
    webCardToken: r.json.webCardToken,
  };
}

beforeAll(() => {
  handle = createDb(inject('apiDbUrl'), { max: 10 });
  app = createApp({
    db: handle.db,
    verifier: createSupabaseVerifier({ supabaseUrl: SUPABASE_URL, jwtSecret: JWT_SECRET }),
    config: { requireSuperadminMfa: false, publicBaseUrl: 'http://localhost:5173', trustProxy: true },
    mailer: new MemoryMailer(),
  });
});
afterAll(() => handle?.close());

// ---------------------------------------------------------------------------
const STAFF_PATTERNS = [
  'POST /v1/staff/device/pair',
  'GET /v1/staff/device',
  'POST /v1/staff/shift',
  'DELETE /v1/staff/shift',
  'GET /v1/staff/scan/:scanToken',
  'GET /v1/staff/memberships',
  'GET /v1/staff/memberships/:membershipId',
  'POST /v1/staff/memberships/:membershipId/earn',
  'POST /v1/staff/memberships/:membershipId/redeem',
  'POST /v1/staff/ledger/:entryId/void',
  'POST /v1/staff/redemptions/:redemptionId/void',
  'POST /v1/staff/memberships/:membershipId/recovery',
];

describe('acceso a la caja', () => {
  it('el registro de rutas del test cubre todas las rutas de caja', () => {
    const routes = new Set(
      app.routes
        .filter((r) => r.path.startsWith('/v1/staff') && r.method !== 'ALL')
        .map((r) => `${r.method} ${r.path}`),
    );
    expect([...routes].sort()).toEqual([...STAFF_PATTERNS].sort());
  });

  it('sin dispositivo autorizado, ninguna ruta de caja responde datos (401)', async () => {
    const anon = new Browser();
    const m = seedMembershipId('barberia', 3);
    for (const p of STAFF_PATTERNS.filter((x) => x !== 'POST /v1/staff/device/pair')) {
      const [method, path] = p.split(' ') as [string, string];
      const r = await anon.req(
        method,
        path
          .replace(':scanToken', '0'.repeat(22))
          .replace(':membershipId', m)
          .replace(':entryId', m)
          .replace(':redemptionId', m),
        { body: method === 'GET' ? undefined : {} },
      );
      expect([r.status, r.json?.error?.code], p).toEqual([401, 'device_not_authorized']);
    }
  });

  it('el QR de autorización: un solo uso, cookie httpOnly/SameSite=Strict de 180 días solo para /v1/staff', async () => {
    const { device, code } = await pairDevice(A);
    const cookie = device.lastSetCookie.find((c) => c.startsWith('aw_device='))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/v1\/staff/);
    expect(cookie).toMatch(/Max-Age=15552000/);
    expect(cookie).not.toMatch(/Secure/); // http://localhost; con https sí (test aparte)
    // En la base solo queda el hash del secreto.
    const secret = device.cookies.get('aw_device')!;
    const [d] = await withSystemTx(handle.db, (tx) =>
      tx
        .select()
        .from(schema.workerDevices)
        .where(eq(schema.workerDevices.deviceSecretHash, hashToken(secret))),
    );
    expect(d).toMatchObject({
      organizationId: A.id,
      name: 'Caja mostrador',
      authorizedBy: A.owner.orgUserId,
    });

    const again = await new Browser().req('POST', '/v1/staff/device/pair', { body: { code } });
    expect([again.status, again.json.error.code]).toEqual([410, 'pairing_invalid']);
  });

  it('el QR de autorización vence a los 10 minutos', async () => {
    const p = await owner.req('POST', `/v1/orgs/${A.id}/devices/pairings`, {
      user: A.owner.id,
      body: { name: 'Tablet' },
    });
    const minutes = (new Date(p.json.expiresAt).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(9);
    expect(minutes).toBeLessThanOrEqual(10);
    const code = p.json.url.split('/caja/vincular/')[1];
    await withSystemTx(handle.db, (tx) =>
      tx
        .update(schema.devicePairings)
        .set({ expiresAt: sql`now() - interval '1 second'` })
        .where(eq(schema.devicePairings.codeHash, hashToken(code))),
    );
    expect((await new Browser().req('POST', '/v1/staff/device/pair', { body: { code } })).status).toBe(410);
  });

  it('con URL pública https la cookie lleva Secure', async () => {
    const httpsApp = createApp({
      db: handle.db,
      verifier: createSupabaseVerifier({ supabaseUrl: SUPABASE_URL, jwtSecret: JWT_SECRET }),
      config: { requireSuperadminMfa: false, publicBaseUrl: 'https://aimentwallet.test', trustProxy: true },
    });
    const p = await owner.req('POST', `/v1/orgs/${A.id}/devices/pairings`, {
      user: A.owner.id,
      body: { name: 'Caja https' },
      target: httpsApp,
    });
    expect(p.json.url).toMatch(/^https:\/\/aimentwallet\.test\/caja\/vincular\/[0-9A-Za-z]{22}$/);
    const d = new Browser();
    await d.req('POST', '/v1/staff/device/pair', {
      body: { code: p.json.url.split('/caja/vincular/')[1] },
      target: httpsApp,
    });
    expect(d.lastSetCookie.find((c) => c.startsWith('aw_device='))).toMatch(/Secure/);
  });

  it('el dispositivo muestra solo a las personas de SU negocio que tienen PIN', async () => {
    const { device } = await pairDevice(A);
    const r = await device.req('GET', '/v1/staff/device');
    expect(r.status).toBe(200);
    expect(r.json.organization.name).toBe(A.name);
    const ids = r.json.people.map((p: any) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining([A.staff[0].orgUserId, A.staff[1].orgUserId, A.owner.orgUserId]),
    );
    expect(ids).not.toContain(B.staff[0].orgUserId);
    expect(r.json.people[0].role).toBe('staff'); // primero los de caja
    expect(r.json.shift).toBeNull();
    expect(JSON.stringify(r.json)).not.toMatch(/pin_?hash/i);
  });
});

describe('turno con PIN', () => {
  it('PIN correcto abre un turno de 12 h (cookie httpOnly); "Cerrar turno" lo termina', async () => {
    const { device } = await pairDevice(A);
    const r = await login(device, A.staff[0].orgUserId, PIN.staff);
    expect(r.status).toBe(201);
    expect(r.json.shift).toMatchObject({ name: A.staff[0].name, role: 'staff' });
    const cookie = device.lastSetCookie.find((c) => c.startsWith('aw_shift='))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Max-Age=43200/);
    expect((await device.req('GET', '/v1/staff/device')).json.shift.name).toBe(A.staff[0].name);

    expect((await device.req('DELETE', '/v1/staff/shift')).status).toBe(200);
    const after = await device.req('GET', `/v1/staff/memberships/${seedMembershipId('barberia', 2)}`);
    expect([after.status, after.json.error.code]).toEqual([401, 'shift_required']);
  });

  it('5 PIN incorrectos bloquean 15 minutos (aunque luego escriba el correcto); el dueño lo desbloquea cambiando el PIN', async () => {
    const created = await owner.req('POST', `/v1/orgs/${A.id}/team`, {
      user: A.owner.id,
      body: { name: `Bloqueo ${randomInt(1e6)}`, pin: '5829' },
    });
    expect(created.status).toBe(201);
    const person = created.json.person.id;
    const { device } = await pairDevice(A);
    const remaining: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await login(device, person, '0000');
      expect(r.json.error.code).toBe('invalid_pin');
      remaining.push(r.json.error.details.remaining);
    }
    expect(remaining).toEqual([4, 3, 2, 1]);
    const fifth = await login(device, person, '0000');
    expect([fifth.status, fifth.json.error.code]).toEqual([429, 'pin_locked']);
    expect(fifth.json.error.message).toMatch(/15 minutos/);
    expect((await login(device, person, '5829')).json.error.code).toBe('pin_locked');
    const [log] = await withSystemTx(handle.db, (tx) =>
      tx
        .select()
        .from(schema.auditLogs)
        .where(and(eq(schema.auditLogs.action, 'staff.pin_locked'), eq(schema.auditLogs.entityId, person))),
    );
    expect(log).toBeDefined();

    const reset = await owner.req('POST', `/v1/orgs/${A.id}/team/${person}/pin`, {
      user: A.owner.id,
      body: { pin: '6937' },
    });
    expect(reset.status).toBe(200);
    expect((await login(device, person, '6937')).status).toBe(201);
  });

  it('un turno por dispositivo: si entra otra persona, el turno anterior se cierra', async () => {
    const { device } = await pairDevice(A);
    await login(device, A.staff[0].orgUserId, PIN.staff);
    const first = device.cookies.get('aw_shift')!;
    await login(device, A.staff[1].orgUserId, PIN.staff);
    const stale = new Browser();
    stale.cookies.set('aw_device', device.cookies.get('aw_device')!);
    stale.cookies.set('aw_shift', first);
    expect((await stale.req('GET', `/v1/staff/memberships/${seedMembershipId('barberia', 2)}`)).status).toBe(
      401,
    );
    expect((await device.req('GET', `/v1/staff/memberships/${seedMembershipId('barberia', 2)}`)).status).toBe(
      200,
    );
  });

  it('el turno vence a las 12 h', async () => {
    const { device } = await pairDevice(A);
    await login(device, A.staff[0].orgUserId, PIN.staff);
    await withSystemTx(handle.db, (tx) =>
      tx
        .update(schema.staffSessions)
        .set({ expiresAt: sql`now() - interval '1 second'` })
        .where(eq(schema.staffSessions.tokenHash, hashToken(device.cookies.get('aw_shift')!))),
    );
    const r = await device.req('GET', `/v1/staff/memberships/${seedMembershipId('barberia', 2)}`);
    expect([r.status, r.json.error.code]).toEqual([401, 'shift_required']);
  });

  it('una cookie de turno no sirve en otro dispositivo', async () => {
    const one = await pairDevice(A, 'Caja 1');
    const two = await pairDevice(A, 'Caja 2');
    await login(one.device, A.staff[0].orgUserId, PIN.staff);
    two.device.cookies.set('aw_shift', one.device.cookies.get('aw_shift')!);
    expect(
      (await two.device.req('GET', `/v1/staff/memberships/${seedMembershipId('barberia', 2)}`)).status,
    ).toBe(401);
  });

  it('dispositivo revocado o trabajador dado de baja: pierden el acceso de inmediato', async () => {
    const { device } = await pairDevice(A, 'Para revocar');
    await login(device, A.staff[0].orgUserId, PIN.staff);
    const list = await owner.req('GET', `/v1/orgs/${A.id}/devices`, { user: A.owner.id });
    const mine = list.json.devices.find((d: any) => d.name === 'Para revocar' && !d.revokedAt);
    expect(mine.shift.name).toBe(A.staff[0].name); // el panel ve quién está de turno
    expect(
      (await owner.req('POST', `/v1/orgs/${A.id}/devices/${mine.id}/revoke`, { user: A.owner.id })).status,
    ).toBe(200);
    const r = await device.req('GET', '/v1/staff/device');
    expect([r.status, r.json.error.code]).toEqual([401, 'device_not_authorized']);

    const temp = await owner.req('POST', `/v1/orgs/${A.id}/team`, {
      user: A.owner.id,
      body: { name: `Baja ${randomInt(1e6)}`, pin: '7351' },
    });
    const d2 = (await pairDevice(A)).device;
    await login(d2, temp.json.person.id, '7351');
    await owner.req('POST', `/v1/orgs/${A.id}/team/${temp.json.person.id}/deactivate`, { user: A.owner.id });
    expect((await d2.req('GET', `/v1/staff/memberships/${seedMembershipId('barberia', 2)}`)).status).toBe(
      401,
    );
    expect((await login(d2, temp.json.person.id, '7351')).status).toBe(401);
  });
});

describe('equipo desde el panel', () => {
  it('PIN de 4 a 6 números y difícil de adivinar; nunca se devuelve', async () => {
    for (const [pin, code] of [
      ['12', 'invalid_pin_format'],
      ['12a4', 'invalid_pin_format'],
      ['1234', 'weak_pin'],
      ['1111', 'weak_pin'],
      ['987654', 'weak_pin'],
    ])
      expect(
        (await owner.req('POST', `/v1/orgs/${A.id}/team`, { user: A.owner.id, body: { name: 'Nuevo', pin } }))
          .json.error.code,
      ).toBe(code);
    const team = await owner.req('GET', `/v1/orgs/${A.id}/team`, { user: A.owner.id });
    expect(team.json.team.find((p: any) => p.isMe)).toMatchObject({ id: A.owner.orgUserId, hasPin: true });
    expect(JSON.stringify(team.json)).not.toMatch(/argon2|pinHash/);
  });

  it('el admin cambia el PIN de un trabajador, pero no el del dueño', async () => {
    const r = await owner.req('POST', `/v1/orgs/${A.id}/team/${A.owner.orgUserId}/pin`, {
      user: A.admin.id,
      body: { pin: '8264' },
    });
    expect([r.status, r.json.error.code]).toEqual([403, 'forbidden']);
  });

  it('otro negocio no ve ni toca el equipo o los dispositivos de A', async () => {
    expect((await owner.req('GET', `/v1/orgs/${A.id}/team`, { user: B.owner.id })).status).toBe(404);
    expect(
      (
        await owner.req('POST', `/v1/orgs/${B.id}/team/${A.staff[0].orgUserId}/pin`, {
          user: B.owner.id,
          body: { pin: '8264' },
        })
      ).status,
    ).toBe(404);
  });
});

describe('operaciones de caja (sellos)', () => {
  let device: Browser;
  beforeAll(async () => {
    device = (await pairDevice(A)).device;
    expect((await login(device, A.staff[0].orgUserId, PIN.staff)).status).toBe(201);
  });

  it('escanear el QR del cliente abre su ficha; buscar por celular o código también', async () => {
    const c = await newCustomer();
    const r = await device.req('GET', `/v1/staff/scan/${c.scanToken}`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      membershipId: c.membershipId,
      customer: { name: 'Cliente Caja' },
      balance: 0,
      firstVisit: true,
      program: { mode: 'stamps', goal: 10 },
    });
    expect(r.json.customer.phone).toMatch(/\*\*\*/); // celular enmascarado
    expect(r.headers.get('cache-control')).toBe('no-store');
    const byPhone = await device.req('GET', `/v1/staff/memberships?q=${c.phone}`);
    expect(byPhone.json.results).toEqual([expect.objectContaining({ membershipId: c.membershipId })]);
    const byCode = await device.req('GET', `/v1/staff/memberships?q=${c.shortCode.toLowerCase()}`);
    expect(byCode.json.results[0].membershipId).toBe(c.membershipId);
    expect((await device.req('GET', '/v1/staff/memberships?q=Ana')).json.error.code).toBe('invalid_search');
  });

  it('sumar queda a nombre del trabajador, con dispositivo y sucursal; el 2.º intento cae en el límite', async () => {
    const c = await newCustomer();
    const r = await device.req('POST', `/v1/staff/memberships/${c.membershipId}/earn`, { body: {} });
    expect(r.status).toBe(201);
    expect(r.json.view.balance).toBe(1);
    const [entry] = await withSystemTx(handle.db, (tx) =>
      tx.select().from(schema.ledgerEntries).where(eq(schema.ledgerEntries.id, r.json.entries[0].id)),
    );
    expect(entry).toMatchObject({
      actorType: 'staff',
      actorId: A.staff[0].orgUserId,
      branchId: A.branchId,
    });
    expect(entry!.deviceId).toBeTruthy();

    const again = await device.req('POST', `/v1/staff/memberships/${c.membershipId}/earn`, { body: {} });
    expect([again.status, again.json.error.code]).toEqual([409, 'cooldown_active']);
    expect(again.json.error.details.overridable).toBe(true);
  });

  it('reintento con la misma clave (señal débil): no duplica', async () => {
    const c = await newCustomer();
    const k = key();
    const r1 = await device.req('POST', `/v1/staff/memberships/${c.membershipId}/earn`, {
      body: {},
      headers: { 'idempotency-key': k },
    });
    const r2 = await device.req('POST', `/v1/staff/memberships/${c.membershipId}/earn`, {
      body: {},
      headers: { 'idempotency-key': k },
    });
    expect([r1.status, r2.status]).toEqual([201, 200]);
    expect(r2.json.view.balance).toBe(1);
  });

  it('excepción de límite con PIN del dueño: PIN incorrecto → 403; correcto → pasa y queda auditado quién autorizó', async () => {
    const c = await newCustomer();
    await device.req('POST', `/v1/staff/memberships/${c.membershipId}/earn`, { body: {} });
    const bad = await device.req('POST', `/v1/staff/memberships/${c.membershipId}/earn`, {
      body: { override: { reason: 'Vino dos veces hoy', pin: PIN.staff } }, // un trabajador no autoriza
    });
    expect([bad.status, bad.json.error.code]).toEqual([403, 'invalid_override_pin']);
    const ok = await device.req('POST', `/v1/staff/memberships/${c.membershipId}/earn`, {
      body: { override: { reason: 'Vino dos veces hoy', pin: PIN.owner } },
    });
    expect(ok.status).toBe(201);
    expect(ok.json.overriddenLimits).toEqual(['cooldown_active']);
    const [log] = await withSystemTx(handle.db, (tx) =>
      tx
        .select()
        .from(schema.auditLogs)
        .where(
          and(
            eq(schema.auditLogs.action, 'limits.overridden'),
            eq(schema.auditLogs.entityId, ok.json.entries[0].id),
          ),
        ),
    );
    expect(log).toMatchObject({ actorId: A.staff[0].orgUserId });
    expect(log!.after).toMatchObject({ approvedBy: A.owner.orgUserId, reason: 'Vino dos veces hoy' });
  });

  it('meta completa → premio; canje; anular el canje devuelve el premio', async () => {
    const c = await newCustomer();
    // 9 sellos previos (migración de tarjeta física) cargados por el dueño desde el panel.
    await owner.req('POST', `/v1/orgs/${A.id}/memberships/${c.membershipId}/adjust`, {
      user: A.owner.id,
      body: { delta: 9, reason: 'Tarjeta física anterior' },
    });
    const earned = await device.req('POST', `/v1/staff/memberships/${c.membershipId}/earn`, { body: {} });
    expect(earned.json.earnedRewards).toEqual([
      expect.objectContaining({ name: 'Corte gratis', status: 'available' }),
    ]);
    expect(earned.json.view.availableRewards).toHaveLength(1);

    const redeemed = await device.req('POST', `/v1/staff/memberships/${c.membershipId}/redeem`, {
      body: { earnedRewardId: earned.json.earnedRewards[0].id },
    });
    expect(redeemed.status).toBe(201);
    expect(redeemed.json.view.availableRewards).toHaveLength(0);
    const item = redeemed.json.view.activity.find((a: any) => a.type === 'redemption');
    expect(item).toMatchObject({ label: 'Corte gratis', canVoid: true });

    const voided = await device.req('POST', `/v1/staff/redemptions/${item.id}/void`, {
      body: { reason: 'Se equivocó de cliente' },
    });
    expect(voided.status).toBe(201);
    expect(voided.json.view.availableRewards).toHaveLength(1);
  });

  it('anular: el trabajador solo su último movimiento; el aviso explica cuándo anular primero la visita que completó la meta', async () => {
    const c = await newCustomer();
    const mine = await device.req('POST', `/v1/staff/memberships/${c.membershipId}/earn`, { body: {} });
    const entryId = mine.json.entries[0].id;
    const canVoid = mine.json.view.activity.find((a: any) => a.id === entryId).canVoid;
    expect(canVoid).toBe(true);
    const v = await device.req('POST', `/v1/staff/ledger/${entryId}/void`, {
      body: { reason: 'Error de caja' },
    });
    expect(v.status).toBe(201);
    expect(v.json.view.balance).toBe(0);
    expect(v.json.view.firstVisit).toBe(true); // se anuló la única visita

    // Movimiento de otra persona (el dueño, desde el panel): el trabajador no puede anularlo.
    const theirs = await owner.req('POST', `/v1/orgs/${A.id}/memberships/${c.membershipId}/adjust`, {
      user: A.owner.id,
      body: { delta: 2, reason: 'Ajuste de prueba' },
    });
    const denied = await device.req('POST', `/v1/staff/ledger/${theirs.json.entries[0].id}/void`, {
      body: { reason: 'Error de caja' },
    });
    expect([denied.status, denied.json.error.code]).toEqual([409, 'void_not_own']);
  });

  it('el dueño en caja (con su PIN) anula cualquier movimiento y no necesita autorización extra', async () => {
    const { device: d } = await pairDevice(A);
    expect((await login(d, A.owner.orgUserId, PIN.owner)).json.shift.role).toBe('owner');
    const c = await newCustomer();
    const theirs = await device.req('POST', `/v1/staff/memberships/${c.membershipId}/earn`, { body: {} });
    const view = await d.req('GET', `/v1/staff/memberships/${c.membershipId}`);
    expect(view.json.activity[0].canVoid).toBe(true);
    const again = await d.req('POST', `/v1/staff/memberships/${c.membershipId}/earn`, {
      body: { override: { reason: 'Cliente frecuente, autorizo' } },
    });
    expect(again.status).toBe(201);
    const v = await d.req('POST', `/v1/staff/ledger/${theirs.json.entries[0].id}/void`, {
      body: { reason: 'Corrección del dueño' },
    });
    expect(v.status).toBe(201);
  });

  it('recuperación en caja: QR de un solo uso, auditado a nombre del trabajador y del dispositivo', async () => {
    const c = await newCustomer();
    const r = await device.req('POST', `/v1/staff/memberships/${c.membershipId}/recovery`, { body: {} });
    expect(r.status).toBe(201);
    expect(r.json.qrSvg).toContain('<svg');
    const [log] = await withSystemTx(handle.db, (tx) =>
      tx
        .select()
        .from(schema.auditLogs)
        .where(
          and(
            eq(schema.auditLogs.action, 'card.recovery_issued'),
            eq(schema.auditLogs.entityId, c.membershipId),
          ),
        )
        .orderBy(desc(schema.auditLogs.createdAt)),
    );
    expect(log).toMatchObject({ actorType: 'staff', actorId: A.staff[0].orgUserId });
    expect((log!.after as any).deviceId).toBeTruthy();
    const token = r.json.recoveryUrl.split('/r/')[1];
    const redeem = await owner.req('POST', '/v1/public/recovery/redeem', { body: { token } });
    expect(redeem.status).toBe(200);
    expect((await owner.req('GET', `/v1/public/cards/${c.webCardToken}`)).status).toBe(404); // URL anterior rotada
  });
});

describe('operaciones de caja (puntos y bienvenida)', () => {
  it('puntos: importe obligatorio, S/ con decimales, tope por operación con excepción del dueño', async () => {
    const { device } = await pairDevice(B);
    await login(device, B.staff[0].orgUserId, PIN.staff);
    const c = await newCustomer(B.linkSlug);
    const missing = await device.req('POST', `/v1/staff/memberships/${c.membershipId}/earn`, { body: {} });
    expect([missing.status, missing.json.error.code]).toEqual([422, 'amount_required']);
    const ok = await device.req('POST', `/v1/staff/memberships/${c.membershipId}/earn`, {
      body: { amount: '25.90' },
    });
    expect(ok.json.view.balance).toBe(25);
    const big = await device.req('POST', `/v1/staff/memberships/${c.membershipId}/earn`, {
      body: { amount: 650 },
    });
    expect([big.status, big.json.error.code, big.json.error.details.overridable]).toEqual([
      409,
      'max_amount_per_tx',
      true,
    ]);
    const approved = await device.req('POST', `/v1/staff/memberships/${c.membershipId}/earn`, {
      body: { amount: 650, override: { reason: 'Compra corporativa', pin: PIN.owner } },
    });
    expect(approved.json.view.balance).toBe(675);
    const americano = approved.json.view.catalog.find((r: any) => r.cost === 50);
    const red = await device.req('POST', `/v1/staff/memberships/${c.membershipId}/redeem`, {
      body: { rewardId: americano.id },
    });
    expect(red.json.view.balance).toBe(625);
  });

  it('bono de bienvenida en la 1.ª visita validada (no al registrarse)', async () => {
    const rules = await owner.req('POST', `/v1/orgs/${C.id}/program/rules`, {
      user: C.owner.id,
      body: {
        earnRule: { type: 'per_visit', units: 1 },
        goal: 6,
        welcomeBonus: { type: 'units', units: 1 },
        limits: { cooldown_minutes: 240, max_units_per_tx: 1, staff_daily_units: 200 },
      },
    });
    expect(rules.status).toBe(201);
    const { device } = await pairDevice(C);
    await login(device, C.staff[0].orgUserId, PIN.staff);
    const c = await newCustomer(C.linkSlug);
    expect((await device.req('GET', `/v1/staff/scan/${c.scanToken}`)).json.balance).toBe(0);
    const r = await device.req('POST', `/v1/staff/memberships/${c.membershipId}/earn`, { body: {} });
    expect(r.json.entries.map((e: any) => e.kind)).toEqual(['earn', 'bonus']);
    expect(r.json.view.balance).toBe(2);
    expect(r.json.view.firstVisit).toBe(false);
  });
});

describe('aislamiento: un dispositivo solo opera su propio negocio', () => {
  it('con el dispositivo de A, nada de B: ni QR, ni ficha, ni operaciones (404) y sin cambios', async () => {
    const { device } = await pairDevice(A);
    await login(device, A.staff[0].orgUserId, PIN.staff);
    const cafe = await newCustomer(B.linkSlug);
    const bEntry = await (async () => {
      const bDevice = (await pairDevice(B)).device;
      await login(bDevice, B.staff[0].orgUserId, PIN.staff);
      return (
        await bDevice.req('POST', `/v1/staff/memberships/${cafe.membershipId}/earn`, { body: { amount: 80 } })
      ).json;
    })();
    const before = await withSystemTx(handle.db, (tx) =>
      tx.execute(sql`select
        (select count(*)::int from app.ledger_entries where organization_id = ${B.id}) as entries,
        (select count(*)::int from app.card_recovery_tokens where organization_id = ${B.id}) as recoveries,
        (select balance from app.memberships where id = ${cafe.membershipId}) as balance`),
    );
    const calls: [string, string, unknown?][] = [
      ['GET', `/v1/staff/scan/${cafe.scanToken}`],
      ['GET', `/v1/staff/memberships/${cafe.membershipId}`],
      ['POST', `/v1/staff/memberships/${cafe.membershipId}/earn`, { amount: 10 }],
      ['POST', `/v1/staff/memberships/${cafe.membershipId}/redeem`, { rewardId: B.rewardId }],
      ['POST', `/v1/staff/ledger/${bEntry.entries[0].id}/void`, { reason: 'Intento cruzado' }],
      ['POST', `/v1/staff/memberships/${cafe.membershipId}/recovery`, {}],
    ];
    for (const [method, path, body] of calls) {
      const r = await device.req(method, path, { body });
      expect(r.status, `${method} ${path}`).toBe(404);
    }
    const [redemption] = await withSystemTx(handle.db, (tx) =>
      tx
        .select({ id: schema.redemptions.id })
        .from(schema.redemptions)
        .where(eq(schema.redemptions.organizationId, B.id))
        .limit(1),
    );
    expect(
      (
        await device.req('POST', `/v1/staff/redemptions/${redemption!.id}/void`, {
          body: { reason: 'Intento cruzado' },
        })
      ).status,
    ).toBe(404);
    // Buscar el celular de un cliente de B desde A no lo encuentra.
    expect((await device.req('GET', `/v1/staff/memberships?q=${cafe.phone}`)).json.results).toEqual([]);
    const after = await withSystemTx(handle.db, (tx) =>
      tx.execute(sql`select
        (select count(*)::int from app.ledger_entries where organization_id = ${B.id}) as entries,
        (select count(*)::int from app.card_recovery_tokens where organization_id = ${B.id}) as recoveries,
        (select balance from app.memberships where id = ${cafe.membershipId}) as balance`),
    );
    expect(after).toEqual(before);
  });

  it('una persona de B no puede abrir turno en un dispositivo de A', async () => {
    const { device } = await pairDevice(A);
    const r = await login(device, B.staff[0].orgUserId, PIN.staff);
    expect([r.status, r.json.error.code]).toEqual([401, 'invalid_pin']);
  });

  it('límite de búsquedas por dispositivo (30 por minuto)', async () => {
    const { device } = await pairDevice(A);
    await login(device, A.staff[0].orgUserId, PIN.staff);
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++)
      statuses.push((await device.req('GET', '/v1/staff/memberships?q=999999999')).status);
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});
