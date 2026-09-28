/* eslint-disable @typescript-eslint/no-explicit-any -- test: respuestas JSON dinámicas de la API */
/**
 * Edición de nombre y celular del cliente desde su ficha (pedido del fundador tras la semana 5):
 * auditoría obligatoria, sin duplicados y sin tocar la membresía ni el historial.
 */
import { createDb, schema, withSystemTx, type DbHandle } from '@aiment/db';
import { SEED } from '@aiment/db/seed-data';
import { MemoryMailer } from '@aiment/mail';
import { MemoryStorage } from '@aiment/storage';
import { randomInt, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApp, type App } from './app';
import { createSupabaseVerifier } from './auth/verifier';

const SUPABASE_URL = 'http://127.0.0.1:54321';
const JWT_SECRET = 'test-secret-with-at-least-32-characters!!';
const A = SEED.orgs.barberia;
const B = SEED.orgs.cafe;

let handle: DbHandle;
let app: App;
let ip = 0;
const newPhone = () => `9${randomInt(10_000_000, 99_999_999)}`;

async function req(method: string, path: string, opts: { user?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-forwarded-for': `10.88.${Math.floor(++ip / 250)}.${ip % 250}`,
    'idempotency-key': `ce_${randomUUID().replaceAll('-', '')}`,
  };
  if (opts.user)
    headers.authorization = `Bearer ${await new SignJWT({ role: 'authenticated', aal: 'aal1' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(opts.user)
      .setIssuer(`${SUPABASE_URL}/auth/v1`)
      .setAudience('authenticated')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(JWT_SECRET))}`;
  const res = await app.request(path, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* no JSON */
  }
  return { status: res.status, json, text };
}

/** Registra un cliente por el flujo público y devuelve sus ids y el token de su tarjeta. */
async function newCustomer(name = 'Ana Lucía Pérez') {
  const phone = newPhone();
  const r = await req('POST', '/v1/public/register', {
    body: { code: A.linkSlug, fullName: name, phone, acceptTerms: true, acceptPrivacy: true, channel: 'qr' },
  });
  expect(r.json.status).toBe('created');
  const [row] = await withSystemTx(handle.db, (tx) =>
    tx
      .select({ customerId: schema.customers.id, membershipId: schema.memberships.id })
      .from(schema.customers)
      .innerJoin(schema.memberships, eq(schema.memberships.customerId, schema.customers.id))
      .where(and(eq(schema.customers.organizationId, A.id), eq(schema.customers.phoneE164, `+51${phone}`))),
  );
  return { ...row!, phone, card: r.json.webCardToken as string };
}

async function membershipSnapshot(membershipId: string) {
  const [m] = await withSystemTx(handle.db, (tx) =>
    tx.execute(sql`select m.id, m.short_code, m.member_scan_token, m.web_card_token_hash, m.balance, m.status,
      (select count(*)::int from app.ledger_entries l where l.membership_id = m.id) as entries
      from app.memberships m where m.id = ${membershipId}`),
  );
  return m;
}

const edit = (customerId: string, body: unknown, user: string = A.owner.id) =>
  req('PATCH', `/v1/orgs/${A.id}/customers/${customerId}`, { user, body });

beforeAll(() => {
  handle = createDb(inject('apiDbUrl'), { max: 8 });
  app = createApp({
    db: handle.db,
    verifier: createSupabaseVerifier({ supabaseUrl: SUPABASE_URL, jwtSecret: JWT_SECRET }),
    config: { requireSuperadminMfa: false, publicBaseUrl: 'http://localhost:5173', trustProxy: true },
    mailer: new MemoryMailer(),
    storage: new MemoryStorage(),
  });
});
afterAll(() => handle?.close());

describe('editar nombre y celular del cliente', () => {
  it('corrige nombre y celular sin tocar la membresía, sus tokens, el saldo ni el historial', async () => {
    const c = await newCustomer('Ana Lucia Peres');
    // Un movimiento previo, para comprobar que el historial se conserva.
    const adj = await req('POST', `/v1/orgs/${A.id}/memberships/${c.membershipId}/adjust`, {
      user: A.owner.id,
      body: { delta: 3, reason: 'Tarjeta física anterior' },
    });
    expect(adj.status).toBe(201);
    const before = await membershipSnapshot(c.membershipId);

    const phone = newPhone();
    const r = await edit(c.customerId, {
      fullName: 'Ana Lucía Pérez',
      phone: `+51 ${phone.slice(0, 3)} ${phone.slice(3)}`,
      reason: 'El cliente corrigió sus datos',
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      customer: { fullName: 'Ana Lucía Pérez', phone: `+51${phone}` },
      changed: ['fullName', 'phone'],
    });

    expect(await membershipSnapshot(c.membershipId)).toEqual(before);
    const card = await req('GET', `/v1/public/cards/${c.card}`);
    expect(card.status).toBe(200); // la misma URL de tarjeta sigue funcionando
    expect(card.json.customer.name).toBe('Ana Lucía Pérez');
    expect(card.json.balance).toBe(3);

    const detail = await req('GET', `/v1/orgs/${A.id}/customers/${c.customerId}`, { user: A.owner.id });
    expect(detail.json.customer).toMatchObject({ fullName: 'Ana Lucía Pérez', phone: `+51${phone}` });
    expect(detail.json.movements.length).toBeGreaterThanOrEqual(1);
  });

  it('queda auditado con motivo y sin guardar el nombre ni el celular completos', async () => {
    const c = await newCustomer('Pedro Castillo');
    const phone = newPhone();
    await edit(c.customerId, { fullName: 'Pedro Castilla', phone, reason: 'Error al registrarse' });
    const [log] = await withSystemTx(handle.db, (tx) =>
      tx
        .select()
        .from(schema.auditLogs)
        .where(
          and(eq(schema.auditLogs.action, 'customer.updated'), eq(schema.auditLogs.entityId, c.customerId)),
        ),
    );
    expect(log).toMatchObject({ organizationId: A.id, actorType: 'owner', actorId: A.owner.orgUserId });
    expect(log!.after).toMatchObject({ fields: ['fullName', 'phone'], reason: 'Error al registrarse' });
    const raw = JSON.stringify([log!.before, log!.after]);
    for (const secret of [phone, c.phone, 'Castilla', 'Castillo']) expect(raw).not.toContain(secret);
    expect((log!.after as any).phone).toMatch(/^\+51 \d{3} \*\*\* \d{3}$/);
  });

  it('avisa a los pases (Wallet) para que muestren el nombre nuevo', async () => {
    const c = await newCustomer();
    await edit(c.customerId, { fullName: 'Nombre Corregido', reason: 'Corrección de nombre' });
    const events = await withSystemTx(handle.db, (tx) =>
      tx
        .select({ type: schema.eventOutbox.type })
        .from(schema.eventOutbox)
        .where(
          and(
            eq(schema.eventOutbox.aggregateId, c.membershipId),
            eq(schema.eventOutbox.type, 'membership.updated'),
          ),
        ),
    );
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it('no permite usar el celular de otro cliente del negocio (no se unen tarjetas)', async () => {
    const a = await newCustomer();
    const b = await newCustomer();
    const r = await edit(a.customerId, { phone: b.phone, reason: 'Cambio de celular' });
    expect([r.status, r.json.error.code]).toEqual([409, 'phone_in_use']);
    const [still] = await withSystemTx(handle.db, (tx) =>
      tx
        .select({ phone: schema.customers.phoneE164 })
        .from(schema.customers)
        .where(eq(schema.customers.id, a.customerId)),
    );
    expect(still!.phone).toBe(`+51${a.phone}`);
  });

  it('el mismo celular sí puede existir en OTRO negocio (el cliente es por negocio)', async () => {
    const a = await newCustomer();
    const [cafeCustomer] = await withSystemTx(handle.db, (tx) =>
      tx
        .select({ phone: schema.customers.phoneE164 })
        .from(schema.customers)
        .where(and(eq(schema.customers.organizationId, B.id), eq(schema.customers.status, 'active')))
        .limit(1),
    );
    const r = await edit(a.customerId, {
      phone: cafeCustomer!.phone,
      reason: 'Celular compartido con otro negocio',
    });
    expect(r.status).toBe(200);
  });

  it('dos ediciones simultáneas hacia el mismo celular: solo una gana', async () => {
    const a = await newCustomer();
    const b = await newCustomer();
    const target = newPhone();
    const [r1, r2] = await Promise.all([
      edit(a.customerId, { phone: target, reason: 'Cambio de celular' }),
      edit(b.customerId, { phone: target, reason: 'Cambio de celular' }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const [{ n }] = (await withSystemTx(handle.db, (tx) =>
      tx.execute(
        sql`select count(*)::int as n from app.customers where organization_id = ${A.id} and phone_e164 = ${`+51${target}`}`,
      ),
    )) as unknown as [{ n: number }];
    expect(n).toBe(1);
  });

  it('el celular anterior queda libre y el nuevo ya no permite un registro duplicado', async () => {
    const c = await newCustomer();
    const phone = newPhone();
    await edit(c.customerId, { phone, reason: 'Cambió de número' });
    const withNew = await req('POST', '/v1/public/register', {
      body: { code: A.linkSlug, fullName: 'Otra Persona', phone, acceptTerms: true, acceptPrivacy: true },
    });
    expect(withNew.json.status).toBe('already_registered');
    const withOld = await req('POST', '/v1/public/register', {
      body: {
        code: A.linkSlug,
        fullName: 'Nuevo Dueño Del Número',
        phone: c.phone,
        acceptTerms: true,
        acceptPrivacy: true,
      },
    });
    expect(withOld.json.status).toBe('created');
  });

  it('valida motivo, nombre y celular; sin cambios responde claro', async () => {
    const c = await newCustomer('Rosa Díaz');
    const cases: [unknown, number, string][] = [
      [{ fullName: 'Rosa María Díaz' }, 422, 'reason_required'],
      [{ fullName: 'Rosa María Díaz', reason: 'ok' }, 422, 'reason_required'],
      [{ fullName: '12345', reason: 'Corrección' }, 422, 'invalid_name'],
      [{ phone: '014567890', reason: 'Corrección' }, 422, 'invalid_phone'],
      [{ reason: 'Corrección de datos' }, 422, 'nothing_to_change'],
      [{ fullName: 'Rosa  Díaz', reason: 'Corrección de datos' }, 409, 'no_change'],
      [{ phone: c.phone, reason: 'Corrección de datos' }, 409, 'no_change'],
    ];
    for (const [body, status, code] of cases) {
      const r = await edit(c.customerId, body);
      expect([r.status, r.json?.error?.code], JSON.stringify(body)).toEqual([status, code]);
    }
  });

  it('roles y aislamiento: el admin puede; otro negocio y el superadmin no; un cliente dado de baja no se edita', async () => {
    const c = await newCustomer();
    expect(
      (await edit(c.customerId, { fullName: 'Editado Por Admin', reason: 'Corrección' }, A.admin.id)).status,
    ).toBe(200);
    expect(
      (await edit(c.customerId, { fullName: 'Intruso Total', reason: 'Corrección' }, B.owner.id)).status,
    ).toBe(404);
    expect(
      (await edit(c.customerId, { fullName: 'Intruso Total', reason: 'Corrección' }, SEED.superadmin.id))
        .status,
    ).toBe(404);
    const cross = await req('PATCH', `/v1/orgs/${B.id}/customers/${c.customerId}`, {
      user: B.owner.id,
      body: { fullName: 'Intruso Total', reason: 'Corrección' },
    });
    expect(cross.status).toBe(404);

    const gone = await newCustomer();
    await req('POST', `/v1/orgs/${A.id}/customers/${gone.customerId}/anonymize`, {
      user: A.owner.id,
      body: { confirm: 'BAJA', reason: 'Pidió la baja' },
    });
    expect((await edit(gone.customerId, { fullName: 'Revivido', reason: 'Corrección' })).status).toBe(404);
  });
});
