/* eslint-disable @typescript-eslint/no-explicit-any -- test: respuestas JSON dinámicas de la API */
/**
 * Flujo público del cliente por HTTP: QR/NFC → landing → registro → tarjeta web → QR de caja,
 * y recuperación de la tarjeta (correo y en caja). Base de test aiment_test, correo en memoria.
 */
import { createDb, schema, withSystemTx, type DbHandle } from '@aiment/db';
import { SEED, seedMembershipId } from '@aiment/db/seed-data';
import { hashToken } from '@aiment/enrollment';
import { MemoryMailer } from '@aiment/mail';
import { randomInt } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApp, type App } from './app';
import { createSupabaseVerifier } from './auth/verifier';

const SUPABASE_URL = 'http://127.0.0.1:54321';
const JWT_SECRET = 'test-secret-with-at-least-32-characters!!';
const PUBLIC = 'https://aimentwallet.test';
const A = SEED.orgs.barberia;
const B = SEED.orgs.cafe;

let handle: DbHandle;
let app: App;
let mailer: MemoryMailer;
let ipCounter = 0;

const freshIp = () => `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;
const newPhone = () => `9${randomInt(10_000_000, 99_999_999)}`;

async function req(
  method: string,
  path: string,
  opts: { body?: unknown; ip?: string; headers?: Record<string, string>; user?: string; app?: App } = {},
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-forwarded-for': opts.ip ?? freshIp(),
    ...opts.headers,
  };
  if (opts.user)
    headers.authorization = `Bearer ${await new SignJWT({ role: 'authenticated', aal: 'aal1' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(opts.user)
      .setIssuer(`${SUPABASE_URL}/auth/v1`)
      .setAudience('authenticated')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(JWT_SECRET))}`;
  const res = await (opts.app ?? app).request(path, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* no es JSON */
  }
  return { status: res.status, headers: res.headers, text, json };
}

const registration = (over: Record<string, unknown> = {}) => ({
  code: A.linkSlug,
  fullName: 'María Fernanda Rojas',
  phone: newPhone(),
  acceptTerms: true,
  acceptPrivacy: true,
  acceptMarketing: false,
  channel: 'qr',
  ...over,
});

async function waitForMail(to: string, after = 0) {
  for (let i = 0; i < 50; i++) {
    const m = mailer.sent.slice(after).find((x) => x.to === to);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 40));
  }
  return undefined;
}
const linkFrom = (text: string) => /https?:\/\/\S+\/r\/([0-9A-Za-z]{22})/.exec(text)?.[1];

async function countWhere(table: 'customers' | 'memberships', phone?: string) {
  const [r] = await withSystemTx(handle.db, (tx) =>
    table === 'customers'
      ? tx.execute(
          sql`select count(*)::int as n from app.customers where organization_id = ${A.id} and phone_e164 = ${phone!}`,
        )
      : tx.execute(
          sql`select count(*)::int as n from app.memberships m join app.customers c on c.id = m.customer_id where c.organization_id = ${A.id} and c.phone_e164 = ${phone!}`,
        ),
  );
  return (r as { n: number }).n;
}

beforeAll(() => {
  handle = createDb(inject('apiDbUrl'), { max: 10 });
  mailer = new MemoryMailer();
  app = createApp({
    db: handle.db,
    verifier: createSupabaseVerifier({ supabaseUrl: SUPABASE_URL, jwtSecret: JWT_SECRET }),
    config: {
      requireSuperadminMfa: false,
      publicBaseUrl: PUBLIC,
      trustProxy: true,
      visitorSalt: 'test-salt-0123456789',
    },
    mailer,
  });
});
afterAll(() => handle?.close());

describe('QR/NFC del local → landing', () => {
  it('QR y NFC usan la misma URL corta; se registra el canal y redirige a la landing', async () => {
    const q = await req('GET', `/go/${A.linkSlug}?c=q`);
    const n = await req('GET', `/go/${A.linkSlug}?c=n`);
    expect(q.status).toBe(302);
    expect(q.headers.get('location')).toMatch(new RegExp(`^/join/${A.linkSlug}\\?c=qr&v=\\d+$`));
    expect(n.headers.get('location')).toMatch(/c=nfc&v=\d+$/);
    const visitId = Number(/v=(\d+)/.exec(q.headers.get('location')!)![1]);
    const [visit] = await withSystemTx(handle.db, (tx) =>
      tx.select().from(schema.channelVisits).where(eq(schema.channelVisits.id, visitId)),
    );
    expect(visit).toMatchObject({ channel: 'qr', organizationId: A.id });
    expect(visit!.visitorHash).toMatch(/^[0-9a-f]{32}$/); // hash diario, nunca la IP
  });

  it('un enlace inexistente lleva a una página neutra', async () => {
    const r = await req('GET', '/go/ZZZZZ?c=q');
    expect([r.status, r.headers.get('location')]).toEqual([302, '/enlace-no-disponible']);
  });

  it('la landing muestra marca, programa y textos legales; no expone datos de clientes', async () => {
    const r = await req('GET', `/v1/public/join/${A.linkSlug}`);
    expect(r.status).toBe(200);
    expect(r.json.organization).toMatchObject({ name: A.name, branding: { poweredBy: true } });
    expect(r.json.program).toMatchObject({ mode: 'stamps', goal: 10, unitLabel: 'sellos' });
    expect(r.json.consents.terms.version).toBe(1);
    expect(r.text).not.toMatch(/\+51\d{9}/);
    expect((await req('GET', '/v1/public/join/NOEXISTE')).status).toBe(404);
  });
});

describe('registro', () => {
  it('crea cliente, consentimientos y membresía con dos tokens distintos; sin puntos al registrarse', async () => {
    const q = await req('GET', `/go/${A.linkSlug}?c=q`);
    const visitId = Number(/v=(\d+)/.exec(q.headers.get('location')!)![1]);
    const phone = newPhone();
    const r = await req('POST', '/v1/public/register', {
      body: registration({
        phone: `${phone.slice(0, 3)} ${phone.slice(3, 6)} ${phone.slice(6)}`,
        acceptMarketing: true,
        visitId,
      }),
    });
    expect(r.status).toBe(201);
    expect(r.json.status).toBe('created');
    expect(r.headers.get('cache-control')).toBe('no-store');

    const [m] = await withSystemTx(handle.db, (tx) =>
      tx
        .select({
          id: schema.memberships.id,
          web: schema.memberships.webCardTokenHash,
          scan: schema.memberships.memberScanToken,
          balance: schema.memberships.balance,
          phone: schema.customers.phoneE164,
          customerId: schema.customers.id,
        })
        .from(schema.memberships)
        .innerJoin(schema.customers, eq(schema.customers.id, schema.memberships.customerId))
        .where(eq(schema.memberships.webCardTokenHash, hashToken(r.json.webCardToken))),
    );
    expect(m!.phone).toBe(`+51${phone}`);
    expect(m!.scan).not.toBe(r.json.webCardToken);
    // La base guarda solo el hash de la URL de la tarjeta, nunca el token en claro.
    expect(m!.web).toBe(hashToken(r.json.webCardToken));
    expect(m!.web).not.toContain(r.json.webCardToken);
    expect(m!.balance).toBe(0);
    const entries = await withSystemTx(handle.db, (tx) =>
      tx.select().from(schema.ledgerEntries).where(eq(schema.ledgerEntries.membershipId, m!.id)),
    );
    expect(entries).toHaveLength(0);
    const consents = await withSystemTx(handle.db, (tx) =>
      tx
        .select({
          kind: schema.consentVersions.kind,
          granted: schema.customerConsents.granted,
          channel: schema.customerConsents.channel,
        })
        .from(schema.customerConsents)
        .innerJoin(
          schema.consentVersions,
          eq(schema.consentVersions.id, schema.customerConsents.consentVersionId),
        )
        .where(eq(schema.customerConsents.customerId, m!.customerId)),
    );
    expect(consents.map((c) => `${c.kind}:${c.granted}:${c.channel}`).sort()).toEqual([
      'marketing:true:qr',
      'privacy:true:qr',
      'terms:true:qr',
    ]);
    const [visit] = await withSystemTx(handle.db, (tx) =>
      tx.select().from(schema.channelVisits).where(eq(schema.channelVisits.id, visitId)),
    );
    expect(visit!.convertedMembershipId).toBe(m!.id);
  });

  it('el mismo celular (en otro formato) no crea una segunda membresía', async () => {
    const phone = newPhone();
    const first = await req('POST', '/v1/public/register', { body: registration({ phone }) });
    const again = await req('POST', '/v1/public/register', {
      body: registration({ phone: `+51 ${phone}`, fullName: 'Otra Persona' }),
    });
    expect(first.json.status).toBe('created');
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ status: 'already_registered' });
    expect(again.json.webCardToken).toBeUndefined(); // no entrega la tarjeta de otra persona
    expect(await countWhere('customers', `+51${phone}`)).toBe(1);
    expect(await countWhere('memberships', `+51${phone}`)).toBe(1);
  });

  it('si el celular ya existe, el enlace se envía al correo REGISTRADO, no al que se escribe ahora', async () => {
    const phone = newPhone();
    const first = await req('POST', '/v1/public/register', {
      body: registration({ phone, email: 'duena.real@correo.test' }),
    });
    expect(first.json.status).toBe('created');
    const before = mailer.sent.length;
    await req('POST', '/v1/public/register', { body: registration({ phone, email: 'intruso@correo.test' }) });
    expect(await waitForMail('duena.real@correo.test', before)).toBeDefined();
    expect(mailer.sent.slice(before).some((m) => m.to === 'intruso@correo.test')).toBe(false);
  });

  it('5 registros simultáneos del mismo celular → 1 cliente y 1 membresía', async () => {
    // Esta prueba es de concurrencia en la base: se sube el límite por celular para que pasen los 5.
    const relaxed = createApp({
      db: handle.db,
      verifier: createSupabaseVerifier({ supabaseUrl: SUPABASE_URL, jwtSecret: JWT_SECRET }),
      config: {
        requireSuperadminMfa: false,
        publicBaseUrl: PUBLIC,
        trustProxy: true,
        rateLimits: { registerPhone: 10 },
      },
      mailer,
    });
    const phone = newPhone();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        req('POST', '/v1/public/register', { body: registration({ phone }), app: relaxed }),
      ),
    );
    expect(results.filter((r) => r.json?.status === 'created')).toHaveLength(1);
    expect(results.filter((r) => r.json?.status === 'already_registered')).toHaveLength(4);
    expect(await countWhere('memberships', `+51${phone}`)).toBe(1);
  });

  it('valida consentimientos, celular, nombre y fecha', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ acceptTerms: false }, 'invalid_registration'],
      [{ acceptPrivacy: undefined }, 'invalid_registration'],
      [{ phone: '014567890' }, 'invalid_phone'],
      [{ fullName: '1234' }, 'invalid_registration'],
      [{ email: 'no-es-correo' }, 'invalid_registration'],
      [{ birthDate: '2030-01-01' }, 'invalid_birth_date'],
      [{ birthDate: '1990-02-31' }, 'invalid_birth_date'],
    ];
    // Cumpleaños en el formato que escribe el cliente (dd/mm/aaaa) también se valida.
    cases.push(
      [{ birthDate: '31/02/1990' }, 'invalid_birth_date'],
      [{ birthDate: '1990/02/01' }, 'invalid_registration'],
    );
    for (const [over, code] of cases) {
      const r = await req('POST', '/v1/public/register', { body: registration(over) });
      expect([r.status, r.json?.error?.code], JSON.stringify(over)).toEqual([422, code]);
    }
    expect(
      (await req('POST', '/v1/public/register', { body: registration({ code: 'NOEXISTE' }) })).status,
    ).toBe(404);
  });

  it('cumpleaños en formato dd/mm/aaaa: se guarda como fecha', async () => {
    const r = await req('POST', '/v1/public/register', { body: registration({ birthDate: '07/03/1991' }) });
    expect(r.status).toBe(201);
    const [c] = await withSystemTx(handle.db, (tx) =>
      tx
        .select({ birthDate: schema.customers.birthDate })
        .from(schema.memberships)
        .innerJoin(schema.customers, eq(schema.customers.id, schema.memberships.customerId))
        .where(eq(schema.memberships.webCardTokenHash, hashToken(r.json.webCardToken))),
    );
    expect(c!.birthDate).toBe('1991-03-07');
  });

  it('IP compartida (Wi-Fi del local o CGNAT): 12 clientes distintos se registran sin bloqueo', async () => {
    const ip = '203.0.113.50';
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++)
      statuses.push((await req('POST', '/v1/public/register', { ip, body: registration() })).status);
    expect(statuses.every((s) => s === 201)).toBe(true);
  });

  it('el mismo celular: máximo 3 intentos cada 10 min, aunque cambie de IP', async () => {
    const phone = newPhone();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++)
      statuses.push((await req('POST', '/v1/public/register', { body: registration({ phone }) })).status);
    expect(statuses).toEqual([201, 200, 200, 429]);
  });

  it('una ráfaga desde una sola IP se frena (30 registros cada 10 min)', async () => {
    const ip = '203.0.113.77';
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++)
      statuses.push((await req('POST', '/v1/public/register', { ip, body: registration() })).status);
    expect(statuses.slice(0, 30).every((s) => s === 201)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});

describe('tarjeta web y QR de caja', () => {
  let web: string;
  let scan: string;
  beforeAll(async () => {
    const r = await req('POST', '/v1/public/register', {
      body: registration({ fullName: 'Rosa Elena Díaz' }),
    });
    web = r.json.webCardToken;
    const [m] = await withSystemTx(handle.db, (tx) =>
      tx
        .select({ scan: schema.memberships.memberScanToken })
        .from(schema.memberships)
        .where(eq(schema.memberships.webCardTokenHash, hashToken(web))),
    );
    scan = m!.scan;
  });

  it('la tarjeta muestra marca, cliente, saldo, progreso, próximo premio, QR y firma', async () => {
    const r = await req('GET', `/v1/public/cards/${web}`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      organization: { name: A.name, branding: { poweredBy: true } },
      program: { mode: 'stamps', unitLabel: 'sellos', goal: 10 },
      customer: { name: 'Rosa Elena Díaz' },
      balance: 0,
      progress: { current: 0, target: 10 },
      nextReward: { name: 'Corte gratis', remaining: 10 },
      scanPath: `/s/${scan}`,
      wallet: { apple: { available: false }, google: { available: false } },
    });
    expect(r.json.shortCode).toMatch(/^[23456789A-Z]{6}$/);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.headers.get('x-robots-tag')).toContain('noindex');
  });

  it('el QR de caja NO revela la URL privada, el nombre ni el saldo', async () => {
    const card = await req('GET', `/v1/public/cards/${web}`);
    expect(card.json.scanPath).not.toContain(web);
    const s = await req('GET', `/v1/public/scan/${scan}`);
    expect(s.status).toBe(200);
    expect(Object.keys(s.json).sort()).toEqual(['message', 'organizationName']);
    expect(s.text).not.toContain(web);
    expect(s.text).not.toMatch(/Rosa|Díaz|balance|saldo/);
  });

  it('los tokens no son intercambiables', async () => {
    expect((await req('GET', `/v1/public/cards/${scan}`)).status).toBe(404); // con el QR no se abre la tarjeta
    expect((await req('GET', `/v1/public/scan/${web}`)).status).toBe(404);
    expect((await req('GET', '/v1/public/cards/no-es-un-token')).status).toBe(404);
  });

  it('refleja los movimientos del motor (sumas y premios)', async () => {
    const [m] = await withSystemTx(handle.db, (tx) =>
      tx
        .select({ id: schema.memberships.id })
        .from(schema.memberships)
        .where(eq(schema.memberships.webCardTokenHash, hashToken(web))),
    );
    const adj = await app.request(`/v1/orgs/${A.id}/memberships/${m!.id}/adjust`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `pub_${m!.id.replaceAll('-', '')}`,
        authorization: `Bearer ${await new SignJWT({ role: 'authenticated', aal: 'aal1' }).setProtectedHeader({ alg: 'HS256' }).setSubject(A.owner.id).setIssuer(`${SUPABASE_URL}/auth/v1`).setAudience('authenticated').setExpirationTime('5m').sign(new TextEncoder().encode(JWT_SECRET))}`,
      },
      body: JSON.stringify({ delta: 12, reason: 'Migración de tarjeta física' }),
    });
    expect(adj.status).toBe(201);
    const r = await req('GET', `/v1/public/cards/${web}`);
    expect(r.json).toMatchObject({
      balance: 2,
      progress: { current: 2, target: 10 },
      redeemable: ['Corte gratis'],
    });
    expect(r.json.history[0]).toMatchObject({ kind: 'adjust', delta: 12 });
  });

  it('puntos: el próximo premio es el más barato que aún no alcanza', async () => {
    const r1 = await req('POST', '/v1/public/register', { body: registration({ code: B.linkSlug }) });
    const card = await req('GET', `/v1/public/cards/${r1.json.webCardToken}`);
    expect(card.json).toMatchObject({
      program: { mode: 'points' },
      balance: 0,
      nextReward: { name: 'Café americano', remaining: 50 },
    });
  });
});

describe('recuperación de tarjeta', () => {
  it('por correo: enlace de un solo uso a la tarjeta EXISTENTE; la respuesta es siempre neutra', async () => {
    const email = `cliente.${randomInt(1e6)}@correo.test`;
    const reg = await req('POST', '/v1/public/register', { body: registration({ email }) });
    const before = mailer.sent.length;

    const r = await req('POST', '/v1/public/recovery', {
      body: { code: A.linkSlug, contact: email.toUpperCase() },
    });
    const unknown = await req('POST', '/v1/public/recovery', {
      body: { code: A.linkSlug, contact: 'nadie@correo.test' },
    });
    expect(r.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(unknown.json.message).toBe(r.json.message); // no revela si existe

    const mail = await waitForMail(email, before);
    const token = linkFrom(mail!.text)!;
    expect(mail!.text).toContain(`${PUBLIC}/r/`);
    expect(mail!.text).not.toContain(reg.json.webCardToken); // el correo no lleva la URL privada
    const redeem = await req('POST', '/v1/public/recovery/redeem', { body: { token } });
    expect(redeem.status).toBe(200);
    // Misma tarjeta (mismo cliente y saldo) con una URL NUEVA: la anterior deja de funcionar.
    expect(redeem.json.webCardToken).not.toBe(reg.json.webCardToken);
    const before2 = await req('GET', `/v1/public/cards/${reg.json.webCardToken}`);
    const after2 = await req('GET', `/v1/public/cards/${redeem.json.webCardToken}`);
    expect(before2.status).toBe(404);
    expect(after2.status).toBe(200);
    expect(after2.json.customer.name).toBe('María Fernanda Rojas');
    const reuse = await req('POST', '/v1/public/recovery/redeem', { body: { token } });
    expect([reuse.status, reuse.json.error.code]).toEqual([410, 'recovery_invalid']);
    expect(mailer.sent.slice(before).some((m) => m.to === 'nadie@correo.test')).toBe(false);
  });

  it('por celular: el enlace va al correo registrado; sin correo registrado no se envía nada', async () => {
    const phone = newPhone();
    const email = `por.celular.${randomInt(1e6)}@correo.test`;
    await req('POST', '/v1/public/register', { body: registration({ phone, email }) });
    const noEmailPhone = newPhone();
    await req('POST', '/v1/public/register', { body: registration({ phone: noEmailPhone }) });
    const before = mailer.sent.length;
    await req('POST', '/v1/public/recovery', { body: { code: A.linkSlug, contact: phone } });
    await req('POST', '/v1/public/recovery', { body: { code: A.linkSlug, contact: noEmailPhone } });
    expect(await waitForMail(email, before)).toBeDefined();
    expect(mailer.sent.length - before).toBe(1);
  });

  it('el enlace del correo usa la URL configurada aunque la petición traiga otro Host', async () => {
    const email = `host.${randomInt(1e6)}@correo.test`;
    await req('POST', '/v1/public/register', { body: registration({ email }) });
    const before = mailer.sent.length;
    await req('POST', '/v1/public/recovery', {
      body: { code: A.linkSlug, contact: email },
      headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' },
    });
    const mail = await waitForMail(email, before);
    expect(mail!.text).toContain(`${PUBLIC}/r/`);
    expect(mail!.text).not.toContain('evil.example');
  });

  it('máximo 3 correos de recuperación por hora por cliente (aunque los pida por correo y por celular)', async () => {
    const email = `limite.${randomInt(1e6)}@correo.test`;
    const phone = newPhone();
    await req('POST', '/v1/public/register', { body: registration({ email, phone }) });
    const before = mailer.sent.length;
    for (const contact of [email, email, phone, phone, phone])
      await req('POST', '/v1/public/recovery', { body: { code: A.linkSlug, contact } });
    await new Promise((r) => setTimeout(r, 300));
    expect(mailer.sent.slice(before).filter((m) => m.to === email)).toHaveLength(3);
  });

  it('el mismo contacto: máximo 3 pedidos cada 10 min, aunque cambie de IP', async () => {
    const contact = `pedidos.${randomInt(1e6)}@correo.test`;
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++)
      statuses.push(
        (await req('POST', '/v1/public/recovery', { body: { code: A.linkSlug, contact } })).status,
      );
    expect(statuses).toEqual([202, 202, 202, 429]);
  });

  it('un enlace vencido no abre la tarjeta', async () => {
    const email = `vencido.${randomInt(1e6)}@correo.test`;
    await req('POST', '/v1/public/register', { body: registration({ email }) });
    const before = mailer.sent.length;
    await req('POST', '/v1/public/recovery', { body: { code: A.linkSlug, contact: email } });
    const token = linkFrom((await waitForMail(email, before))!.text)!;
    await withSystemTx(handle.db, (tx) =>
      tx.execute(
        sql`update app.card_recovery_tokens set expires_at = now() - interval '1 minute' where token_hash = encode(sha256(${token}::bytea), 'hex')`,
      ),
    );
    expect((await req('POST', '/v1/public/recovery/redeem', { body: { token } })).status).toBe(410);
  });

  it('en caja: el dueño genera un QR de un solo uso (10 min), queda auditado y abre la misma tarjeta', async () => {
    const reg = await req('POST', '/v1/public/register', { body: registration() });
    const [m] = await withSystemTx(handle.db, (tx) =>
      tx
        .select({ id: schema.memberships.id })
        .from(schema.memberships)
        .where(eq(schema.memberships.webCardTokenHash, hashToken(reg.json.webCardToken))),
    );
    const issued = await req('POST', `/v1/orgs/${A.id}/memberships/${m!.id}/recovery`, { user: A.owner.id });
    expect(issued.status).toBe(201);
    expect(issued.json.recoveryUrl).toMatch(new RegExp(`^${PUBLIC}/r/[0-9A-Za-z]{22}$`));
    expect(issued.json.qrSvg).toContain('<svg');
    const minutes = (new Date(issued.json.expiresAt).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(9);
    expect(minutes).toBeLessThanOrEqual(10);
    const token = issued.json.recoveryUrl.split('/r/')[1];
    const recovered = await req('POST', '/v1/public/recovery/redeem', { body: { token } });
    expect(recovered.json.webCardToken).not.toBe(reg.json.webCardToken); // se rota
    const [rotated] = await withSystemTx(handle.db, (tx) =>
      tx
        .select({ id: schema.memberships.id })
        .from(schema.memberships)
        .where(eq(schema.memberships.webCardTokenHash, hashToken(recovered.json.webCardToken))),
    );
    expect(rotated!.id).toBe(m!.id); // la misma membresía, no una nueva
    expect((await req('POST', '/v1/public/recovery/redeem', { body: { token } })).status).toBe(410);
    const [log] = await withSystemTx(handle.db, (tx) =>
      tx
        .select()
        .from(schema.auditLogs)
        .where(
          and(eq(schema.auditLogs.action, 'card.recovery_issued'), eq(schema.auditLogs.entityId, m!.id)),
        ),
    );
    expect(log).toBeDefined();
    // Otro negocio no puede generar recuperaciones para este cliente
    expect(
      (await req('POST', `/v1/orgs/${A.id}/memberships/${m!.id}/recovery`, { user: B.owner.id })).status,
    ).toBe(404);
    expect(
      (
        await req('POST', `/v1/orgs/${B.id}/memberships/${seedMembershipId('barberia', 1)}/recovery`, {
          user: B.owner.id,
        })
      ).status,
    ).toBe(404);
  });

  it('dos aperturas simultáneas del mismo enlace → solo una funciona', async () => {
    const reg = await req('POST', '/v1/public/register', { body: registration() });
    const [m] = await withSystemTx(handle.db, (tx) =>
      tx
        .select({ id: schema.memberships.id })
        .from(schema.memberships)
        .where(eq(schema.memberships.webCardTokenHash, hashToken(reg.json.webCardToken))),
    );
    const issued = await req('POST', `/v1/orgs/${A.id}/memberships/${m!.id}/recovery`, { user: A.owner.id });
    const token = issued.json.recoveryUrl.split('/r/')[1];
    const results = await Promise.all(
      Array.from({ length: 5 }, () => req('POST', '/v1/public/recovery/redeem', { body: { token } })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });
});

describe('panel: enlaces impresos', () => {
  it('lista el enlace de la sucursal con URL de QR y de NFC (misma URL corta, distinto canal)', async () => {
    const r = await req('GET', `/v1/orgs/${A.id}/links`, { user: A.owner.id });
    expect(r.status).toBe(200);
    expect(r.json.links[0]).toMatchObject({
      slug: A.linkSlug,
      qrUrl: `${PUBLIC}/go/${A.linkSlug}?c=q`,
      nfcUrl: `${PUBLIC}/go/${A.linkSlug}?c=n`,
    });
    const svg = await req('GET', `/v1/orgs/${A.id}/links/${r.json.links[0].id}/qr`, { user: A.owner.id });
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');
    expect(svg.text).toContain('<svg');
    const png = await app.request(`/v1/orgs/${A.id}/links/${r.json.links[0].id}/qr?format=png`, {
      headers: {
        authorization: `Bearer ${await new SignJWT({ role: 'authenticated', aal: 'aal1' }).setProtectedHeader({ alg: 'HS256' }).setSubject(A.owner.id).setIssuer(`${SUPABASE_URL}/auth/v1`).setAudience('authenticated').setExpirationTime('5m').sign(new TextEncoder().encode(JWT_SECRET))}`,
      },
    });
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await png.arrayBuffer()).slice(1, 4)).toEqual(new Uint8Array([0x50, 0x4e, 0x47]));
  });
});
