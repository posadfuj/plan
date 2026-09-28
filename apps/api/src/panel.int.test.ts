/* eslint-disable @typescript-eslint/no-explicit-any -- test: respuestas JSON dinámicas de la API */
/**
 * Panel del dueño por HTTP (semana 5): un negocio nuevo de cero a su primera tarjeta, sin tocar código.
 * Alta desde el panel maestro → invitación → marca y logo → programa (plantilla, regla, premios) →
 * sucursales y tope del plan → equipo con sucursal → publicación → registro del cliente → caja →
 * gestión del cliente (bloqueo, URL, baja).
 */
import type { AuthAdmin } from '@aiment/business';
import { createDb, schema, withSystemTx, type DbHandle } from '@aiment/db';
import { SEED } from '@aiment/db/seed-data';
import { hashToken } from '@aiment/enrollment';
import { MemoryMailer } from '@aiment/mail';
import { MemoryStorage } from '@aiment/storage';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApp, type App } from './app';
import { createSupabaseVerifier } from './auth/verifier';

const SUPABASE_URL = 'http://127.0.0.1:54321';
const JWT_SECRET = 'test-secret-with-at-least-32-characters!!';
const C = SEED.orgs.veterinaria; // plan Start: 1 sucursal, 3 trabajadores
const SUPER = SEED.superadmin.id;

let handle: DbHandle;
let app: App;
let noInvitesApp: App;
const mailer = new MemoryMailer();
const storage = new MemoryStorage();
let ip = 0;

/** Supabase Auth simulado: crea la cuenta y devuelve un código de acceso de un solo uso. */
class MemoryAuthAdmin implements AuthAdmin {
  readonly accounts = new Map<string, string>();
  async createAccessLink(email: string) {
    const existing = this.accounts.get(email);
    const userId = existing ?? randomUUID();
    this.accounts.set(email, userId);
    return {
      userId,
      tokenHash: randomBytes(20).toString('hex'),
      type: existing ? 'magiclink' : 'invite',
    } as const;
  }
}
const authAdmin = new MemoryAuthAdmin();

async function jwt(userId: string) {
  return new SignJWT({ role: 'authenticated', aal: 'aal1' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(`${SUPABASE_URL}/auth/v1`)
    .setAudience('authenticated')
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(JWT_SECRET));
}

/** Petición con sesión (user), cookies de caja (jar) o cuerpo binario (raw). */
async function req(
  method: string,
  path: string,
  opts: {
    user?: string;
    body?: unknown;
    raw?: Uint8Array;
    jar?: Map<string, string>;
    target?: App;
  } = {},
) {
  const headers: Record<string, string> = {
    'x-forwarded-for': `10.77.${Math.floor(++ip / 250)}.${ip % 250}`,
    'idempotency-key': `p_${randomUUID().replaceAll('-', '')}`,
  };
  if (opts.raw) headers['content-type'] = 'application/octet-stream';
  else headers['content-type'] = 'application/json';
  if (opts.user) headers.authorization = `Bearer ${await jwt(opts.user)}`;
  if (opts.jar?.size) headers.cookie = [...opts.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await (opts.target ?? app).request(path, {
    method,
    headers,
    body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  if (opts.jar)
    for (const c of res.headers.getSetCookie()) {
      const [name, value] = c.split(';')[0]!.split('=');
      if (!value || /max-age=0/i.test(c)) opts.jar.delete(name!);
      else opts.jar.set(name!, value);
    }
  const buf = new Uint8Array(await res.arrayBuffer());
  let json: any = null;
  try {
    json = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    /* binario */
  }
  return { status: res.status, json, headers: res.headers, bytes: buf };
}

// PNG mínimo válido (1×1) y un SVG con script (debe rechazarse).
const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  ),
);
const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);

beforeAll(() => {
  handle = createDb(inject('apiDbUrl'), { max: 5 });
  const verifier = createSupabaseVerifier({ supabaseUrl: SUPABASE_URL, jwtSecret: JWT_SECRET });
  const config = { requireSuperadminMfa: false, publicBaseUrl: 'http://localhost:5173', trustProxy: true };
  app = createApp({ db: handle.db, verifier, config, mailer, storage, authAdmin });
  noInvitesApp = createApp({ db: handle.db, verifier, config, mailer, storage, authAdmin: null });
});
afterAll(() => handle?.close());

// ---------------------------------------------------------------------------
// Estado compartido del recorrido "de cero a la primera tarjeta"
// ---------------------------------------------------------------------------
const ownerEmail = `duena.${Date.now()}@aiment.test`;
let orgId = '';
let ownerId = '';
let base = '';
let mainBranch = '';
let secondBranch = '';
let staffId = '';
let joinCode = '';

describe('panel maestro: alta de un negocio nuevo', () => {
  it('sin clave de Supabase no se puede invitar (503 claro, no se crea nada)', async () => {
    const before = await withSystemTx(handle.db, (tx) =>
      tx.select({ id: schema.organizations.id }).from(schema.organizations),
    );
    const r = await req('POST', '/v1/admin/orgs', {
      user: SUPER,
      target: noInvitesApp,
      body: {
        name: 'No Se Crea',
        template: 'barberia',
        planCode: 'start',
        ownerEmail: 'x@aiment.test',
        ownerName: 'X Y',
      },
    });
    expect([r.status, r.json.error.code]).toEqual([503, 'invitations_unavailable']);
    const after = await withSystemTx(handle.db, (tx) =>
      tx.select({ id: schema.organizations.id }).from(schema.organizations),
    );
    expect(after.length).toBe(before.length);
  });

  it('un dueño no puede crear negocios', async () => {
    const r = await req('POST', '/v1/admin/orgs', { user: C.owner.id, body: {} });
    expect(r.status).toBe(404);
  });

  it('el superadmin crea el negocio en borrador con sucursal, programa de la plantilla e invitación', async () => {
    const plans = await req('GET', '/v1/admin/plans', { user: SUPER });
    expect(plans.json.plans.map((p: any) => p.code)).toEqual(
      expect.arrayContaining(['start', 'pro', 'multi']),
    );
    expect(plans.json.templates.length).toBeGreaterThanOrEqual(6);

    const r = await req('POST', '/v1/admin/orgs', {
      user: SUPER,
      body: {
        name: 'Lavandería Burbujas',
        template: 'lavanderia',
        planCode: 'multi',
        ownerEmail,
        ownerName: 'Marta Peña',
      },
    });
    expect(r.status).toBe(201);
    expect(r.json.organization).toMatchObject({ name: 'Lavandería Burbujas', status: 'draft' });
    expect(r.json.organization.slug).toMatch(/^lavanderia-burbujas/);
    orgId = r.json.organization.id;
    ownerId = authAdmin.accounts.get(ownerEmail)!;
    base = `/v1/orgs/${orgId}`;

    const mail = mailer.lastTo(ownerEmail)!;
    expect(mail.subject).toContain('Lavandería Burbujas');
    expect(mail.text).toMatch(/http:\/\/localhost:5173\/panel\/acceso\?t=[0-9a-f]{40}&k=invite/);

    const list = await req('GET', '/v1/admin/orgs', { user: SUPER });
    const row = list.json.organizations.find((o: any) => o.id === orgId);
    expect(row).toMatchObject({
      status: 'draft',
      plan: 'multi',
      branches: 1,
      staff: 0,
      customers: 0,
      owner: ownerEmail,
    });
    const audit = await req('GET', '/v1/admin/audit', { user: SUPER });
    expect(audit.json.entries[0]).toMatchObject({ organizationId: orgId, action: 'org.created' });
  });

  it('la dueña invitada entra a su panel (en borrador) y ve solo su negocio', async () => {
    const me = await req('GET', '/v1/me', { user: ownerId });
    expect(me.json.organizations).toEqual([
      expect.objectContaining({ id: orgId, role: 'owner', status: 'draft' }),
    ]);
    const s = await req('GET', `${base}/settings`, { user: ownerId });
    expect(s.status).toBe(200);
    expect(s.json).toMatchObject({
      status: 'draft',
      plan: { code: 'multi' },
      limits: { branches: 10, staff: 50 },
      usage: { branches: 1, staff: 0 },
    });
    const program = await req('GET', `${base}/program`, { user: ownerId });
    expect(program.json).toMatchObject({
      mode: 'stamps',
      unitLabel: 'sellos',
      members: 0,
      rule: { goal: 8 },
    });
    expect(program.json.rewards).toEqual([expect.objectContaining({ kind: 'goal', name: 'Lavado gratis' })]);
    const branches = await req('GET', `${base}/branches`, { user: ownerId });
    expect(branches.json.branches).toHaveLength(1);
    mainBranch = branches.json.branches[0].id;
    joinCode = branches.json.branches[0].slug;
    expect(branches.json.branches[0].qrUrl).toBe(`http://localhost:5173/go/${joinCode}?c=q`);
  });

  it('en borrador el QR todavía no registra clientes', async () => {
    expect((await req('GET', `/v1/public/join/${joinCode}`)).status).toBe(404);
  });

  it('reenviar la invitación manda un enlace nuevo', async () => {
    const r = await req('POST', `/v1/admin/orgs/${orgId}/invite`, { user: SUPER });
    expect(r.json.sentTo).toBe(ownerEmail);
    expect(mailer.sent.filter((m) => m.to === ownerEmail)).toHaveLength(2);
  });
});

describe('marca', () => {
  it('nombre, color, frase, condiciones y contacto; queda auditado', async () => {
    const r = await req('PATCH', `${base}/settings`, {
      user: ownerId,
      body: {
        name: 'Lavandería Burbujas Express',
        primaryColor: '#0e7490',
        tagline: 'Tu ropa lista en 24 horas',
        conditions: 'Un sello por servicio de lavado. No acumulable con otras promociones.',
        contact: {
          phone: '+51 987 654 321',
          email: 'Hola@Burbujas.pe',
          instagram: '@burbujas.pe',
          website: 'https://burbujas.pe',
        },
      },
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      name: 'Lavandería Burbujas Express',
      branding: {
        primaryColor: '#0E7490',
        textColor: '#ffffff',
        tagline: 'Tu ropa lista en 24 horas',
        contact: { email: 'hola@burbujas.pe', instagram: 'burbujas.pe', website: 'https://burbujas.pe' },
      },
      colorCheck: { level: 'ok' },
    });
    const [audit] = await withSystemTx(handle.db, (tx) =>
      tx.execute(
        sql`select action from app.audit_logs where organization_id = ${orgId} and action = 'org.branding_updated'`,
      ),
    );
    expect(audit).toBeTruthy();
  });

  it('un color casi blanco se rechaza con una sugerencia más oscura; uno claro se acepta con aviso', async () => {
    const bad = await req('PATCH', `${base}/settings`, { user: ownerId, body: { primaryColor: '#FAFAF5' } });
    expect([bad.status, bad.json.error.code]).toEqual([422, 'color_low_contrast']);
    expect(bad.json.error.details.suggestion).toMatch(/^#[0-9A-F]{6}$/);
    const light = await req('PATCH', `${base}/settings`, {
      user: ownerId,
      body: { primaryColor: '#FBBF24' },
    });
    expect(light.status).toBe(200);
    expect(light.json.colorCheck).toMatchObject({ level: 'low', text: '#000000' });
    await req('PATCH', `${base}/settings`, { user: ownerId, body: { primaryColor: '#0E7490' } });
  });

  it('datos inválidos → 400 con el campo', async () => {
    const r = await req('PATCH', `${base}/settings`, {
      user: ownerId,
      body: { contact: { website: 'burbujas.pe' }, extra: true },
    });
    expect(r.status).toBe(400);
  });

  it('logo: acepta PNG/JPG/WebP por contenido, rechaza SVG y archivos grandes; se sirve público y cacheable', async () => {
    const svg = await req('PUT', `${base}/settings/logo`, { user: ownerId, raw: SVG });
    expect([svg.status, svg.json.error.code]).toEqual([415, 'logo_type']);
    const big = await req('PUT', `${base}/settings/logo`, {
      user: ownerId,
      raw: new Uint8Array(1024 * 1024 + 10),
    });
    expect(big.status).toBe(413);

    const ok = await req('PUT', `${base}/settings/logo`, { user: ownerId, raw: PNG });
    expect(ok.status).toBe(200);
    const logoUrl: string = ok.json.branding.logoUrl;
    expect(logoUrl).toMatch(new RegExp(`^/v1/public/files/logos/${orgId}/[0-9a-f]{16}\\.png$`));
    const file = await req('GET', logoUrl);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('image/png');
    expect(file.headers.get('x-content-type-options')).toBe('nosniff');
    expect(file.headers.get('cache-control')).toContain('immutable');
    expect(Buffer.from(file.bytes).equals(Buffer.from(PNG))).toBe(true);
    expect((await req('GET', '/v1/public/files/logos/../../etc/passwd')).status).toBe(404);
  });

  it('otro negocio no puede cambiar esta marca', async () => {
    const r = await req('PATCH', `${base}/settings`, { user: C.owner.id, body: { tagline: 'hackeado' } });
    expect(r.status).toBe(404);
    const logo = await req('PUT', `${base}/settings/logo`, { user: C.owner.id, raw: PNG });
    expect(logo.status).toBe(404);
  });
});

describe('programa', () => {
  it('sin clientes se puede cambiar de plantilla (sellos → puntos) y volver', async () => {
    const r = await req('POST', `${base}/program/template`, {
      user: ownerId,
      body: { template: 'cafeteria' },
    });
    expect(r.status).toBe(201);
    let p = await req('GET', `${base}/program`, { user: ownerId });
    expect(p.json).toMatchObject({ mode: 'points', unitLabel: 'puntos', rule: { goal: null, version: 2 } });
    expect(p.json.rewards.filter((x: any) => x.active).map((x: any) => x.kind)).toEqual([
      'catalog',
      'catalog',
      'catalog',
    ]);
    await req('POST', `${base}/program/template`, { user: ownerId, body: { template: 'lavanderia' } });
    p = await req('GET', `${base}/program`, { user: ownerId });
    expect(p.json).toMatchObject({ mode: 'stamps', rule: { goal: 8, version: 3 } });
    expect(p.json.rewards.filter((x: any) => x.active)).toHaveLength(1);
  });

  it('edita nombre, unidades, meta, bienvenida, límites y premio', async () => {
    expect(
      (
        await req('PATCH', `${base}/program`, {
          user: ownerId,
          body: { name: 'Club Burbujas', unitLabel: 'Burbujas' },
        })
      ).status,
    ).toBe(200);
    const p0 = await req('GET', `${base}/program`, { user: ownerId });
    const goal = p0.json.rewards.find((x: any) => x.active && x.kind === 'goal');
    expect(
      (
        await req('PATCH', `${base}/rewards/${goal.id}`, {
          user: ownerId,
          body: { name: 'Lavado + secado gratis' },
        })
      ).status,
    ).toBe(200);
    const rule = await req('POST', `${base}/program/rules`, {
      user: ownerId,
      body: {
        earnRule: { type: 'per_visit', units: 1 },
        goal: 6,
        welcomeBonus: { type: 'units', units: 1 },
        limits: { cooldown_minutes: 60, max_units_per_tx: 1, staff_daily_units: 100 },
        expirationMonths: null,
      },
    });
    expect(rule.status).toBe(201);
    const p = await req('GET', `${base}/program`, { user: ownerId });
    expect(p.json).toMatchObject({
      name: 'Club Burbujas',
      unitLabel: 'burbujas',
      rule: {
        goal: 6,
        welcomeBonus: { type: 'units', units: 1 },
        limits: { cooldown_minutes: 60 },
        expirationMonths: null,
      },
    });
    const bad = await req('PATCH', `${base}/program`, { user: ownerId, body: { unitLabel: '<b>x</b>' } });
    expect(bad.status).toBe(400);
  });
});

describe('sucursales y límites del plan', () => {
  it('crea una sucursal con su propio QR/NFC; nombres únicos', async () => {
    const r = await req('POST', `${base}/branches`, {
      user: ownerId,
      body: { name: 'Sede Miraflores', address: 'Av. Larco 123' },
    });
    expect(r.status).toBe(201);
    secondBranch = r.json.id;
    expect(r.json.slug).toMatch(/^[2-9A-HJ-NP-Z]{6}$/);
    expect(r.json.slug).not.toBe(joinCode);
    const dup = await req('POST', `${base}/branches`, { user: ownerId, body: { name: 'sede miraflores' } });
    expect([dup.status, dup.json.error.code]).toEqual([409, 'name_taken']);
    const list = await req('GET', `${base}/branches`, { user: ownerId });
    expect(list.json.branches.map((b: any) => b.name)).toEqual(['Sede principal', 'Sede Miraflores']);
    expect(
      (
        await req('PATCH', `${base}/branches/${mainBranch}`, {
          user: ownerId,
          body: { name: 'Sede Centro', address: 'Jr. Unión 456' },
        })
      ).status,
    ).toBe(200);
  });

  it('plan Start: una sola sucursal (409 con mensaje para el dueño)', async () => {
    const r = await req('POST', `/v1/orgs/${C.id}/branches`, {
      user: C.owner.id,
      body: { name: 'Otra sede' },
    });
    expect([r.status, r.json.error.code]).toEqual([409, 'plan_limit']);
    expect(r.json.error.message).toContain('Tu plan Start permite hasta 1 sucursal');
  });

  it('plan Start: hasta 3 trabajadores de caja; al dar de baja se libera el cupo', async () => {
    const s = await req('GET', `/v1/orgs/${C.id}/settings`, { user: C.owner.id });
    const free = s.json.limits.staff - s.json.usage.staff;
    const created: string[] = [];
    for (let i = 0; i < free; i++) {
      const r = await req('POST', `/v1/orgs/${C.id}/team`, {
        user: C.owner.id,
        body: { name: `Tope ${randomInt(1e6)}`, pin: '4826' },
      });
      expect(r.status).toBe(201);
      created.push(r.json.person.id);
    }
    const over = await req('POST', `/v1/orgs/${C.id}/team`, {
      user: C.owner.id,
      body: { name: 'Uno Más', pin: '4826' },
    });
    expect([over.status, over.json.error.code]).toEqual([409, 'plan_limit']);
    expect(over.json.error.message).toContain('3 trabajadores de caja');
    await req('POST', `/v1/orgs/${C.id}/team/${created[0]}/deactivate`, { user: C.owner.id });
    expect(
      (
        await req('POST', `/v1/orgs/${C.id}/team`, {
          user: C.owner.id,
          body: { name: 'Uno Más', pin: '4826' },
        })
      ).status,
    ).toBe(201);
    // Reactivar al dado de baja superaría el tope.
    const re = await req('POST', `/v1/orgs/${C.id}/team/${created[0]}/reactivate`, { user: C.owner.id });
    expect([re.status, re.json.error.code]).toEqual([409, 'plan_limit']);
  });

  it('no se desactiva la única sucursal activa', async () => {
    const r = await req('POST', `/v1/orgs/${C.id}/branches/${C.branchId}/deactivate`, { user: C.owner.id });
    expect([r.status, r.json.error.code]).toEqual([409, 'last_branch']);
  });
});

describe('publicación, trabajador por sucursal y caja', () => {
  const jarMain = new Map<string, string>();
  const jarSecond = new Map<string, string>();
  let webCardToken = '';
  let membershipId = '';
  let scanToken = '';

  it('trabajador restringido a una sucursal (se valida que la sucursal sea del negocio)', async () => {
    const foreign = await req('POST', `${base}/team`, {
      user: ownerId,
      body: { name: 'Rosa', pin: '4826', branchIds: [C.branchId] },
    });
    expect([foreign.status, foreign.json.error.code]).toEqual([422, 'invalid_branch']);
    const r = await req('POST', `${base}/team`, {
      user: ownerId,
      body: { name: 'Rosa', pin: '4826', branchIds: [secondBranch] },
    });
    expect(r.status).toBe(201);
    staffId = r.json.person.id;
    const team = await req('GET', `${base}/team`, { user: ownerId });
    expect(team.json.team.find((p: any) => p.id === staffId).branchIds).toEqual([secondBranch]);
  });

  it('en borrador no se pueden autorizar cajas; el superadmin publica y ya se puede', async () => {
    const p = await req('POST', `${base}/devices/pairings`, {
      user: ownerId,
      body: { name: 'Caja Centro', branchId: mainBranch },
    });
    const code = p.json.url.split('/caja/vincular/')[1];
    expect((await req('POST', '/v1/staff/device/pair', { body: { code }, jar: jarMain })).status).toBe(410);

    expect(
      (
        await req('POST', `/v1/admin/orgs/${orgId}/reactivate`, {
          user: SUPER,
          body: { reason: 'no aplica' },
        })
      ).status,
    ).toBe(409);
    const pub = await req('POST', `/v1/admin/orgs/${orgId}/activate`, { user: SUPER });
    expect(pub.json).toEqual({ id: orgId, status: 'live' });
    expect((await req('POST', `/v1/admin/orgs/${orgId}/activate`, { user: SUPER })).status).toBe(409);

    for (const [branchId, jar] of [
      [mainBranch, jarMain],
      [secondBranch, jarSecond],
    ] as const) {
      const pair = await req('POST', `${base}/devices/pairings`, {
        user: ownerId,
        body: { name: `Caja ${branchId.slice(0, 4)}`, branchId },
      });
      const c = pair.json.url.split('/caja/vincular/')[1];
      expect((await req('POST', '/v1/staff/device/pair', { body: { code: c }, jar })).status).toBe(201);
    }
  });

  it('la caja de la otra sucursal no muestra a Rosa ni la deja entrar; la suya sí', async () => {
    const main = await req('GET', '/v1/staff/device', { jar: jarMain });
    expect(main.json.device.branch).toBe('Sede Centro');
    expect(main.json.people.map((p: any) => p.id)).not.toContain(staffId);
    const denied = await req('POST', '/v1/staff/shift', {
      jar: jarMain,
      body: { personId: staffId, pin: '4826' },
    });
    expect(denied.status).toBe(401);
    const second = await req('GET', '/v1/staff/device', { jar: jarSecond });
    expect(second.json.people.map((p: any) => p.id)).toContain(staffId);
    expect(
      (await req('POST', '/v1/staff/shift', { jar: jarSecond, body: { personId: staffId, pin: '4826' } }))
        .status,
    ).toBe(201);
  });

  it('el cliente se registra con la marca y el programa configurados', async () => {
    const join = await req('GET', `/v1/public/join/${joinCode}`);
    expect(join.status).toBe(200);
    expect(join.json.organization).toMatchObject({
      name: 'Lavandería Burbujas Express',
      branding: {
        primaryColor: '#0E7490',
        tagline: 'Tu ropa lista en 24 horas',
        conditions: expect.stringContaining('Un sello por servicio'),
        logoUrl: expect.stringMatching(/^\/v1\/public\/files\/logos\//),
      },
    });
    expect(join.json.program).toMatchObject({ name: 'Club Burbujas', unitLabel: 'burbujas', goal: 6 });
    const reg = await req('POST', '/v1/public/register', {
      body: {
        code: joinCode,
        fullName: 'Ñusta Peña',
        phone: `9${randomInt(10_000_000, 99_999_999)}`,
        email: 'ñusta.peña@correo.pe',
        acceptTerms: true,
        acceptPrivacy: true,
        channel: 'nfc',
      },
    });
    expect(reg.status).toBe(201);
    webCardToken = reg.json.webCardToken;
    const [m] = await withSystemTx(handle.db, (tx) =>
      tx
        .select({ id: schema.memberships.id, scan: schema.memberships.memberScanToken })
        .from(schema.memberships)
        .where(eq(schema.memberships.webCardTokenHash, hashToken(webCardToken))),
    );
    membershipId = m!.id;
    scanToken = m!.scan;
    const card = await req('GET', `/v1/public/cards/${webCardToken}`);
    expect(card.json).toMatchObject({ status: 'active', program: { name: 'Club Burbujas', goal: 6 } });
    expect(card.json.organization.branding.contact.phone).toBe('+51 987 654 321');
  });

  it('con clientes ya no se cambia de plantilla', async () => {
    const r = await req('POST', `${base}/program/template`, {
      user: ownerId,
      body: { template: 'cafeteria' },
    });
    expect([r.status, r.json.error.code]).toEqual([409, 'program_in_use']);
  });

  it('Rosa suma en su caja; el panel lo ve en la lista y en la ficha del cliente', async () => {
    const view = await req('GET', `/v1/staff/scan/${scanToken}`, { jar: jarSecond });
    expect(view.status).toBe(200);
    const earn = await req('POST', `/v1/staff/memberships/${membershipId}/earn`, {
      jar: jarSecond,
      body: {},
    });
    expect(earn.status).toBe(201);
    const list = await req('GET', `${base}/customers?q=peña`, { user: ownerId });
    expect(list.json).toMatchObject({
      total: 1,
      customers: [{ membershipId, balance: 2, status: 'active' }],
    });
    const byCode = await req('GET', `${base}/customers?q=${view.json.shortCode}`, { user: ownerId });
    expect(byCode.json.total).toBe(1);
    const detail = await req('GET', `${base}/customers/${list.json.customers[0].id}`, { user: ownerId });
    expect(detail.json.customer).toMatchObject({ fullName: 'Ñusta Peña', email: 'ñusta.peña@correo.pe' });
    // El bono de bienvenida es automático (sin persona); la suma la hizo Rosa.
    expect(detail.json.movements.map((x: any) => [x.kind, x.by])).toEqual(
      expect.arrayContaining([
        ['earn', 'Rosa'],
        ['bonus', null],
      ]),
    );
  });

  it('al quitarle la sucursal a Rosa, su turno abierto se corta en la siguiente acción', async () => {
    expect((await req('GET', `/v1/staff/memberships/${membershipId}`, { jar: jarSecond })).status).toBe(200);
    const r = await req('PATCH', `${base}/team/${staffId}`, {
      user: ownerId,
      body: { branchIds: [mainBranch] },
    });
    expect(r.status).toBe(200);
    const cut = await req('GET', `/v1/staff/memberships/${membershipId}`, { jar: jarSecond });
    expect([cut.status, cut.json.error.code]).toEqual([401, 'shift_required']);
    const main = await req('GET', '/v1/staff/device', { jar: jarMain });
    expect(main.json.people.map((p: any) => p.id)).toContain(staffId);
  });

  it('bloquear: la caja no suma, la tarjeta abre sin operar; desbloquear lo revierte', async () => {
    expect(
      (await req('POST', `${base}/memberships/${membershipId}/block`, { user: ownerId, body: {} })).status,
    ).toBe(400);
    expect(
      (
        await req('POST', `${base}/memberships/${membershipId}/block`, {
          user: ownerId,
          body: { reason: 'Uso indebido' },
        })
      ).status,
    ).toBe(200);
    await req('POST', '/v1/staff/shift', { jar: jarMain, body: { personId: staffId, pin: '4826' } });
    const earn = await req('POST', `/v1/staff/memberships/${membershipId}/earn`, { jar: jarMain, body: {} });
    expect([earn.status, earn.json.error.code]).toEqual([409, 'membership_inactive']);
    expect((await req('GET', `/v1/public/cards/${webCardToken}`)).json.status).toBe('blocked');
    const blocked = await req('GET', `${base}/customers?status=blocked`, { user: ownerId });
    expect(blocked.json.customers.map((c: any) => c.membershipId)).toEqual([membershipId]);
    expect((await req('POST', `${base}/memberships/${membershipId}/unblock`, { user: ownerId })).status).toBe(
      200,
    );
    expect((await req('GET', `/v1/public/cards/${webCardToken}`)).json.status).toBe('active');
  });

  it('invalidar la URL de la tarjeta: la anterior deja de abrir; se recupera con QR', async () => {
    expect(
      (await req('POST', `${base}/memberships/${membershipId}/rotate-card`, { user: ownerId })).status,
    ).toBe(200);
    expect((await req('GET', `/v1/public/cards/${webCardToken}`)).status).toBe(404);
    const rec = await req('POST', `${base}/memberships/${membershipId}/recovery`, { user: ownerId });
    const token = rec.json.recoveryUrl.split('/r/')[1];
    const redeemed = await req('POST', `/v1/public/recovery/redeem`, { body: { token } });
    expect(redeemed.status).toBe(200);
    webCardToken = redeemed.json.webCardToken;
    expect((await req('GET', `/v1/public/cards/${webCardToken}`)).status).toBe(200);
  });

  it('baja (anonimización): sin datos personales, tarjeta y QR sin efecto, historial intacto', async () => {
    const list = await req('GET', `${base}/customers?q=peña`, { user: ownerId });
    const customerId = list.json.customers[0].id;
    const entriesBefore = await withSystemTx(handle.db, (tx) =>
      tx
        .select({ id: schema.ledgerEntries.id })
        .from(schema.ledgerEntries)
        .where(eq(schema.ledgerEntries.membershipId, membershipId)),
    );
    const noConfirm = await req('POST', `${base}/customers/${customerId}/anonymize`, {
      user: ownerId,
      body: { confirm: 'si' },
    });
    expect([noConfirm.status, noConfirm.json.error.code]).toEqual([422, 'confirmation_required']);
    const r = await req('POST', `${base}/customers/${customerId}/anonymize`, {
      user: ownerId,
      body: { confirm: 'BAJA', reason: 'Lo pidió el cliente' },
    });
    expect(r.status).toBe(200);

    const [row] = await withSystemTx(handle.db, (tx) =>
      tx.execute(sql`select c.full_name, c.phone_e164, c.email, c.birth_date, c.status, m.status as m_status,
        (select count(*)::int from app.customer_consents cc where cc.customer_id = c.id and (cc.ip is not null or cc.user_agent is not null)) as device_data
        from app.customers c join app.memberships m on m.customer_id = c.id where c.id = ${customerId}`),
    );
    expect(row).toEqual({
      full_name: null,
      phone_e164: null,
      email: null,
      birth_date: null,
      status: 'anonymized',
      m_status: 'closed',
      device_data: 0,
    });
    expect((await req('GET', `/v1/public/cards/${webCardToken}`)).status).toBe(404);
    expect((await req('GET', `/v1/staff/scan/${scanToken}`, { jar: jarMain })).status).toBe(404);
    expect((await req('GET', `${base}/customers?q=peña`, { user: ownerId })).json.total).toBe(0);
    expect((await req('GET', `${base}/customers/${customerId}`, { user: ownerId })).status).toBe(404);
    const entriesAfter = await withSystemTx(handle.db, (tx) =>
      tx
        .select({ id: schema.ledgerEntries.id })
        .from(schema.ledgerEntries)
        .where(eq(schema.ledgerEntries.membershipId, membershipId)),
    );
    expect(entriesAfter).toHaveLength(entriesBefore.length);
    // La auditoría no guarda el nombre del cliente.
    const audit = await req('GET', `${base}/audit`, { user: ownerId });
    expect(JSON.stringify(audit.json)).not.toMatch(/Ñusta|peña@/i);
    const again = await req('POST', `${base}/customers/${customerId}/anonymize`, {
      user: ownerId,
      body: { confirm: 'BAJA' },
    });
    expect(again.status).toBe(404);
  });

  it('desactivar una sucursal: su QR deja de registrar y su caja deja de funcionar; se puede reactivar', async () => {
    const branches = await req('GET', `${base}/branches`, { user: ownerId });
    const second = branches.json.branches.find((b: any) => b.id === secondBranch);
    expect((await req('POST', `${base}/branches/${secondBranch}/deactivate`, { user: ownerId })).status).toBe(
      200,
    );
    expect((await req('GET', `/v1/public/join/${second.slug}`)).status).toBe(404);
    expect((await req('GET', '/v1/staff/device', { jar: jarSecond })).status).toBe(401);
    expect((await req('POST', `${base}/branches/${secondBranch}/reactivate`, { user: ownerId })).status).toBe(
      200,
    );
    expect((await req('GET', `/v1/public/join/${second.slug}`)).status).toBe(200);
    expect((await req('GET', '/v1/staff/device', { jar: jarSecond })).status).toBe(200);
  });

  it('cambio de plan por el superadmin (queda auditado)', async () => {
    const r = await req('POST', `/v1/admin/orgs/${orgId}/plan`, { user: SUPER, body: { planCode: 'pro' } });
    expect(r.json).toMatchObject({ plan: 'pro' });
    // Bajar de plan no desactiva nada: la segunda sucursal sigue, pero no se pueden crear más.
    const add = await req('POST', `${base}/branches`, { user: ownerId, body: { name: 'Sede Surco' } });
    expect([add.status, add.json.error.code]).toEqual([409, 'plan_limit']);
    const audit = await req('GET', '/v1/admin/audit', { user: SUPER });
    expect(audit.json.entries.map((e: any) => e.action)).toEqual(
      expect.arrayContaining(['org.plan_changed', 'org.published', 'org.created', 'org.owner_invited']),
    );
  });
});

describe('roles en el panel', () => {
  it('el admin gestiona marca y clientes; no ve la auditoría', async () => {
    const A = SEED.orgs.barberia;
    expect((await req('GET', `/v1/orgs/${A.id}/settings`, { user: A.admin.id })).status).toBe(200);
    expect(
      (await req('PATCH', `/v1/orgs/${A.id}/settings`, { user: A.admin.id, body: { tagline: 'Desde 1998' } }))
        .status,
    ).toBe(200);
    expect((await req('GET', `/v1/orgs/${A.id}/audit`, { user: A.admin.id })).status).toBe(403);
  });

  it('el superadmin no entra al panel de un negocio', async () => {
    expect((await req('GET', `${base}/settings`, { user: SUPER })).status).toBe(404);
    expect((await req('GET', `${base}/customers`, { user: SUPER })).status).toBe(404);
  });
});
