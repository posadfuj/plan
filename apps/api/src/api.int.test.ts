/**
 * Suite de aislamiento y roles a nivel de API (primera capa).
 * Tokens firmados como los emite Supabase Auth (HS256 local); base de test aiment_test.
 */
import { createDb, schema, withSystemTx, type DbHandle } from '@aiment/db';
import { SEED, seedCustomerId, seedMembershipId } from '@aiment/db/seed-data';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApp, type App } from './app';
import { createSupabaseVerifier } from './auth/verifier';

const SUPABASE_URL = 'http://127.0.0.1:54321';
const JWT_SECRET = 'test-secret-with-at-least-32-characters!!';
const A = SEED.orgs.barberia;
const B = SEED.orgs.cafe;
const C = SEED.orgs.veterinaria;

let handle: DbHandle;
let app: App;
let strictApp: App;

async function token(
  userId: string,
  opts: { aal?: 'aal1' | 'aal2'; secret?: string; issuer?: string; expiresIn?: string } = {},
) {
  return new SignJWT({ role: 'authenticated', aal: opts.aal ?? 'aal1', email: 'x@aiment.test' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(opts.issuer ?? `${SUPABASE_URL}/auth/v1`)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? '5m')
    .sign(new TextEncoder().encode(opts.secret ?? JWT_SECRET));
}

async function call(
  target: App,
  method: string,
  path: string,
  userId?: string | null,
  body?: unknown,
  tk?: string,
  extraHeaders: Record<string, string> = {},
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'idempotency-key': `test_${randomUUID().replaceAll('-', '')}`,
    ...extraHeaders,
  };
  const t = tk ?? (userId ? await token(userId) : undefined);
  if (t) headers.authorization = `Bearer ${t}`;
  const res = await target.request(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: Record<string, unknown> & { error?: { code: string } } = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* respuesta no JSON (p. ej. SVG) */
  }
  return { status: res.status, json };
}

/**
 * Todas las rutas de un negocio, con recursos del negocio A. Cualquier ruta nueva debe agregarse aquí:
 * un test falla si la API expone una ruta /v1/orgs/:orgId/... que no esté en esta lista.
 */
type Endpoint = { method: string; path: string; pattern: string; body?: unknown };
const ORG_PATTERNS = [
  'GET /v1/orgs/:orgId',
  'GET /v1/orgs/:orgId/customers',
  'GET /v1/orgs/:orgId/customers/:customerId',
  'GET /v1/orgs/:orgId/audit',
  'GET /v1/orgs/:orgId/program',
  'POST /v1/orgs/:orgId/program/rules',
  'POST /v1/orgs/:orgId/rewards',
  'PATCH /v1/orgs/:orgId/rewards/:rewardId',
  'GET /v1/orgs/:orgId/memberships/:membershipId',
  'POST /v1/orgs/:orgId/memberships/:membershipId/earn',
  'POST /v1/orgs/:orgId/memberships/:membershipId/redeem',
  'POST /v1/orgs/:orgId/memberships/:membershipId/adjust',
  'POST /v1/orgs/:orgId/ledger/:entryId/void',
  'POST /v1/orgs/:orgId/redemptions/:redemptionId/void',
  'GET /v1/orgs/:orgId/links',
  'GET /v1/orgs/:orgId/links/:linkId/qr',
  'POST /v1/orgs/:orgId/memberships/:membershipId/recovery',
  'GET /v1/orgs/:orgId/team',
  'POST /v1/orgs/:orgId/team',
  'POST /v1/orgs/:orgId/team/:orgUserId/pin',
  'POST /v1/orgs/:orgId/team/:orgUserId/deactivate',
  'GET /v1/orgs/:orgId/devices',
  'POST /v1/orgs/:orgId/devices/pairings',
  'POST /v1/orgs/:orgId/devices/:deviceId/revoke',
  // Semana 5: panel del dueño
  'GET /v1/orgs/:orgId/settings',
  'PATCH /v1/orgs/:orgId/settings',
  'PUT /v1/orgs/:orgId/settings/logo',
  'DELETE /v1/orgs/:orgId/settings/logo',
  'PATCH /v1/orgs/:orgId/program',
  'POST /v1/orgs/:orgId/program/template',
  'GET /v1/orgs/:orgId/branches',
  'POST /v1/orgs/:orgId/branches',
  'PATCH /v1/orgs/:orgId/branches/:branchId',
  'POST /v1/orgs/:orgId/branches/:branchId/deactivate',
  'POST /v1/orgs/:orgId/branches/:branchId/reactivate',
  'POST /v1/orgs/:orgId/customers/:customerId/anonymize',
  'PATCH /v1/orgs/:orgId/customers/:customerId',
  'POST /v1/orgs/:orgId/memberships/:membershipId/block',
  'POST /v1/orgs/:orgId/memberships/:membershipId/unblock',
  'POST /v1/orgs/:orgId/memberships/:membershipId/rotate-card',
  'POST /v1/orgs/:orgId/team/:orgUserId/reactivate',
  'PATCH /v1/orgs/:orgId/team/:orgUserId',
];
let ORG_ENDPOINTS: Endpoint[] = [];

async function orgASnapshot() {
  const [r] = await withSystemTx(handle.db, (tx) =>
    tx.execute(sql`select
      (select count(*)::int from app.ledger_entries where organization_id = ${A.id}) as entries,
      (select coalesce(sum(balance), 0)::int from app.memberships where organization_id = ${A.id}) as balances,
      (select count(*)::int from app.rewards where organization_id = ${A.id}) as rewards,
      (select string_agg(name || coalesce(sort_order::text, ''), ',' order by id) from app.rewards where organization_id = ${A.id}) as reward_state,
      (select count(*)::int from app.program_rule_versions where organization_id = ${A.id}) as rules,
      (select count(*)::int from app.redemptions where organization_id = ${A.id} and status = 'voided') as voided,
      (select string_agg(id::text || status::text || coalesce(pin_hash, ''), ',' order by id) from app.organization_users where organization_id = ${A.id}) as team,
      (select count(*)::int from app.worker_devices where organization_id = ${A.id} and revoked_at is null) as devices,
      (select count(*)::int from app.device_pairings where organization_id = ${A.id}) as pairings,
      (select name || branding::text || plan_code from app.organizations where id = ${A.id}) as org,
      (select string_agg(name || coalesce(address, '') || status::text, ',' order by id) from app.branches where organization_id = ${A.id}) as branches,
      (select count(*)::int from app.short_links where organization_id = ${A.id}) as links,
      (select string_agg(id::text || status::text || web_card_token_hash, ',' order by id) from app.memberships where organization_id = ${A.id}) as memberships,
      (select string_agg(id::text || status::text || coalesce(full_name, ''), ',' order by id) from app.customers where organization_id = ${A.id}) as customers,
      (select string_agg(p.name || p.unit_label || p.mode::text || p.current_version_id::text, ',') from app.loyalty_programs p where organization_id = ${A.id}) as program`),
  );
  return r;
}

beforeAll(async () => {
  handle = createDb(inject('apiDbUrl'), { max: 5 });
  const [entry] = await withSystemTx(handle.db, (tx) =>
    tx
      .select({ id: schema.ledgerEntries.id })
      .from(schema.ledgerEntries)
      .where(and(eq(schema.ledgerEntries.organizationId, A.id), eq(schema.ledgerEntries.kind, 'earn')))
      .orderBy(schema.ledgerEntries.createdAt)
      .limit(1),
  );
  const [redemption] = await withSystemTx(handle.db, (tx) =>
    tx
      .select({ id: schema.redemptions.id })
      .from(schema.redemptions)
      .where(eq(schema.redemptions.organizationId, A.id))
      .limit(1),
  );
  const [link] = await withSystemTx(handle.db, (tx) =>
    tx
      .select({ id: schema.shortLinks.id })
      .from(schema.shortLinks)
      .where(eq(schema.shortLinks.organizationId, A.id))
      .limit(1),
  );
  const m = seedMembershipId('barberia', 3);
  const base = `/v1/orgs/${A.id}`;
  // Un trabajador, un dispositivo y un cliente de A creados solo para estas pruebas (baja, revocación, bloqueo).
  const tempStaff = randomUUID();
  const tempDevice = randomUUID();
  const tempCustomer = randomUUID();
  const tempMembership = randomUUID();
  await withSystemTx(handle.db, async (tx) => {
    await tx
      .insert(schema.organizationUsers)
      .values({ id: tempStaff, organizationId: A.id, displayName: 'Temporal (test)', role: 'staff' });
    await tx.insert(schema.workerDevices).values({
      id: tempDevice,
      organizationId: A.id,
      branchId: A.branchId,
      name: 'Caja (test)',
      deviceSecretHash: randomUUID(),
      authorizedBy: A.owner.orgUserId,
    });
    await tx.insert(schema.customers).values({
      id: tempCustomer,
      organizationId: A.id,
      fullName: 'Cliente Temporal',
      phoneE164: `+5199${String(Date.now()).slice(-7)}`,
    });
    await tx.insert(schema.memberships).values({
      id: tempMembership,
      organizationId: A.id,
      programId: A.programId,
      customerId: tempCustomer,
      memberScanToken: randomUUID().replaceAll('-', '').slice(0, 22),
      webCardTokenHash: randomUUID(),
      shortCode: `T${String(Date.now()).slice(-5)}`,
    });
  });
  ORG_ENDPOINTS = [
    { method: 'GET', path: base, pattern: 'GET /v1/orgs/:orgId' },
    { method: 'GET', path: `${base}/customers`, pattern: 'GET /v1/orgs/:orgId/customers' },
    {
      method: 'GET',
      path: `${base}/customers/${seedCustomerId('barberia', 1)}`,
      pattern: 'GET /v1/orgs/:orgId/customers/:customerId',
    },
    { method: 'GET', path: `${base}/audit`, pattern: 'GET /v1/orgs/:orgId/audit' },
    { method: 'GET', path: `${base}/program`, pattern: 'GET /v1/orgs/:orgId/program' },
    {
      method: 'POST',
      path: `${base}/program/rules`,
      pattern: 'POST /v1/orgs/:orgId/program/rules',
      body: {
        earnRule: { type: 'per_visit', units: 1 },
        goal: 10,
        limits: { cooldown_minutes: 240, max_units_per_tx: 1, staff_daily_units: 200 },
      },
    },
    {
      method: 'POST',
      path: `${base}/rewards`,
      pattern: 'POST /v1/orgs/:orgId/rewards',
      body: { kind: 'gift', name: 'Regalo (test de acceso)' },
    },
    {
      method: 'PATCH',
      path: `${base}/rewards/${A.rewardId}`,
      pattern: 'PATCH /v1/orgs/:orgId/rewards/:rewardId',
      body: { sortOrder: 0 },
    },
    {
      method: 'GET',
      path: `${base}/memberships/${m}`,
      pattern: 'GET /v1/orgs/:orgId/memberships/:membershipId',
    },
    {
      method: 'POST',
      path: `${base}/memberships/${m}/earn`,
      pattern: 'POST /v1/orgs/:orgId/memberships/:membershipId/earn',
      body: {},
    },
    {
      method: 'POST',
      path: `${base}/memberships/${m}/redeem`,
      pattern: 'POST /v1/orgs/:orgId/memberships/:membershipId/redeem',
      body: { rewardId: A.rewardId },
    },
    {
      method: 'POST',
      path: `${base}/memberships/${m}/adjust`,
      pattern: 'POST /v1/orgs/:orgId/memberships/:membershipId/adjust',
      body: { delta: 1, reason: 'Prueba de acceso' },
    },
    {
      method: 'POST',
      path: `${base}/ledger/${entry!.id}/void`,
      pattern: 'POST /v1/orgs/:orgId/ledger/:entryId/void',
      body: { reason: 'Prueba de acceso' },
    },
    {
      method: 'POST',
      path: `${base}/redemptions/${redemption!.id}/void`,
      pattern: 'POST /v1/orgs/:orgId/redemptions/:redemptionId/void',
      body: { reason: 'Prueba de acceso' },
    },
    { method: 'GET', path: `${base}/links`, pattern: 'GET /v1/orgs/:orgId/links' },
    { method: 'GET', path: `${base}/links/${link!.id}/qr`, pattern: 'GET /v1/orgs/:orgId/links/:linkId/qr' },
    {
      method: 'POST',
      path: `${base}/memberships/${m}/recovery`,
      pattern: 'POST /v1/orgs/:orgId/memberships/:membershipId/recovery',
    },
    { method: 'GET', path: `${base}/team`, pattern: 'GET /v1/orgs/:orgId/team' },
    {
      method: 'POST',
      path: `${base}/team`,
      pattern: 'POST /v1/orgs/:orgId/team',
      body: { name: 'Acceso Prueba', pin: '4826' },
    },
    {
      method: 'POST',
      // El dueño "cambia" su PIN por el mismo del seed: no altera otras pruebas.
      path: `${base}/team/${A.owner.orgUserId}/pin`,
      pattern: 'POST /v1/orgs/:orgId/team/:orgUserId/pin',
      body: { pin: SEED.pins.owner },
    },
    {
      method: 'POST',
      path: `${base}/team/${tempStaff}/deactivate`,
      pattern: 'POST /v1/orgs/:orgId/team/:orgUserId/deactivate',
    },
    { method: 'GET', path: `${base}/devices`, pattern: 'GET /v1/orgs/:orgId/devices' },
    {
      method: 'POST',
      path: `${base}/devices/pairings`,
      pattern: 'POST /v1/orgs/:orgId/devices/pairings',
      body: { name: 'Caja de acceso' },
    },
    {
      method: 'POST',
      path: `${base}/devices/${tempDevice}/revoke`,
      pattern: 'POST /v1/orgs/:orgId/devices/:deviceId/revoke',
    },
    { method: 'GET', path: `${base}/settings`, pattern: 'GET /v1/orgs/:orgId/settings' },
    {
      method: 'PATCH',
      path: `${base}/settings`,
      pattern: 'PATCH /v1/orgs/:orgId/settings',
      body: { tagline: 'Cortes clásicos y modernos' },
    },
    // Cuerpo JSON en lugar de imagen: el dueño recibe 415 (formato), el de otro negocio 404.
    { method: 'PUT', path: `${base}/settings/logo`, pattern: 'PUT /v1/orgs/:orgId/settings/logo', body: {} },
    { method: 'DELETE', path: `${base}/settings/logo`, pattern: 'DELETE /v1/orgs/:orgId/settings/logo' },
    {
      method: 'PATCH',
      path: `${base}/program`,
      pattern: 'PATCH /v1/orgs/:orgId/program',
      body: { name: 'Club Barbería Pedro' },
    },
    {
      // Con clientes no se cambia de plantilla: 409 para el dueño.
      method: 'POST',
      path: `${base}/program/template`,
      pattern: 'POST /v1/orgs/:orgId/program/template',
      body: { template: 'cafeteria' },
    },
    { method: 'GET', path: `${base}/branches`, pattern: 'GET /v1/orgs/:orgId/branches' },
    // Plan Pro: 1 sucursal → 409 para el dueño.
    {
      method: 'POST',
      path: `${base}/branches`,
      pattern: 'POST /v1/orgs/:orgId/branches',
      body: { name: 'Sucursal de acceso' },
    },
    {
      method: 'PATCH',
      path: `${base}/branches/${A.branchId}`,
      pattern: 'PATCH /v1/orgs/:orgId/branches/:branchId',
      body: { name: 'Sede principal', address: 'Lima, Perú' },
    },
    // Única sucursal activa → 409 (no se desactiva); ya activa → 409 al reactivar.
    {
      method: 'POST',
      path: `${base}/branches/${A.branchId}/deactivate`,
      pattern: 'POST /v1/orgs/:orgId/branches/:branchId/deactivate',
    },
    {
      method: 'POST',
      path: `${base}/branches/${A.branchId}/reactivate`,
      pattern: 'POST /v1/orgs/:orgId/branches/:branchId/reactivate',
    },
    // Sin motivo → 422 (no se modifica nada).
    {
      method: 'PATCH',
      path: `${base}/customers/${tempCustomer}`,
      pattern: 'PATCH /v1/orgs/:orgId/customers/:customerId',
      body: { fullName: 'Intento De Cambio' },
    },
    // Sin la palabra BAJA → 422 (no se anonimiza a nadie).
    {
      method: 'POST',
      path: `${base}/customers/${tempCustomer}/anonymize`,
      pattern: 'POST /v1/orgs/:orgId/customers/:customerId/anonymize',
      body: {},
    },
    {
      method: 'POST',
      path: `${base}/memberships/${tempMembership}/block`,
      pattern: 'POST /v1/orgs/:orgId/memberships/:membershipId/block',
      body: { reason: 'Prueba de acceso' },
    },
    {
      method: 'POST',
      path: `${base}/memberships/${tempMembership}/unblock`,
      pattern: 'POST /v1/orgs/:orgId/memberships/:membershipId/unblock',
    },
    {
      method: 'POST',
      path: `${base}/memberships/${tempMembership}/rotate-card`,
      pattern: 'POST /v1/orgs/:orgId/memberships/:membershipId/rotate-card',
    },
    {
      method: 'POST',
      path: `${base}/team/${tempStaff}/reactivate`,
      pattern: 'POST /v1/orgs/:orgId/team/:orgUserId/reactivate',
    },
    {
      method: 'PATCH',
      path: `${base}/team/${tempStaff}`,
      pattern: 'PATCH /v1/orgs/:orgId/team/:orgUserId',
      body: { branchIds: [A.branchId] },
    },
  ];
  const verifier = createSupabaseVerifier({ supabaseUrl: SUPABASE_URL, jwtSecret: JWT_SECRET });
  app = createApp({ db: handle.db, verifier, config: { requireSuperadminMfa: false } });
  strictApp = createApp({ db: handle.db, verifier, config: { requireSuperadminMfa: true } });
});
afterAll(() => handle?.close());

describe('autenticación', () => {
  it('health responde sin sesión', async () => {
    expect((await call(app, 'GET', '/health')).status).toBe(200);
  });

  it('sin token → 401', async () => {
    const r = await call(app, 'GET', '/v1/me');
    expect(r.status).toBe(401);
    expect(r.json.error?.code).toBe('missing_token');
  });

  it('token con firma, emisor o vigencia inválidos → 401', async () => {
    for (const tk of [
      await token(A.owner.id, { secret: 'otro-secreto-de-al-menos-32-caracteres!!' }),
      await token(A.owner.id, { issuer: 'https://evil.example/auth/v1' }),
      await token(A.owner.id, { expiresIn: '-1m' }),
      'no-es-un-jwt',
    ])
      expect((await call(app, 'GET', '/v1/me', null, undefined, tk)).status).toBe(401);
  });

  it('usuario válido en Supabase pero sin alta en Aiment Wallet → 403', async () => {
    const r = await call(app, 'GET', '/v1/me', '00000000-0000-4000-8000-00000000dead');
    expect(r.status).toBe(403);
    expect(r.json.error?.code).toBe('user_not_provisioned');
  });

  it('/v1/me lista solo los negocios del usuario', async () => {
    const r = await call(app, 'GET', '/v1/me', A.owner.id);
    expect(r.status).toBe(200);
    expect(r.json.organizations).toEqual([expect.objectContaining({ id: A.id, role: 'owner' })]);
  });
});

describe('aislamiento entre negocios (API)', () => {
  it('el registro de rutas del test cubre todas las rutas de negocio de la API', () => {
    const appRoutes = new Set(
      app.routes
        .filter((r) => r.path.startsWith('/v1/orgs/:orgId') && r.method !== 'ALL')
        .map((r) => `${r.method} ${r.path.replace(/\/$/, '')}`),
    );
    const covered = new Set(ORG_PATTERNS);
    expect([...appRoutes].filter((r) => !covered.has(r))).toEqual([]);
    expect(new Set(ORG_ENDPOINTS.map((e) => e.pattern))).toEqual(covered);
  });

  it('el dueño de B recibe 404 en TODAS las rutas del negocio A y no modifica nada', async () => {
    const before = await orgASnapshot();
    for (const e of ORG_ENDPOINTS) {
      const r = await call(app, e.method, e.path, B.owner.id, e.body);
      expect(r.status, `${e.method} ${e.path}`).toBe(404);
      expect(r.json.error?.code).toBe('not_found');
    }
    expect(await orgASnapshot()).toEqual(before);
  });

  it('el dueño de A llega a todas las rutas de su negocio (autorizado; puede haber reglas de negocio)', async () => {
    for (const e of ORG_ENDPOINTS) {
      const r = await call(app, e.method, e.path, A.owner.id, e.body);
      expect(
        [401, 403, 404, 500],
        `${e.method} ${e.path} → ${r.status} ${JSON.stringify(r.json.error)}`,
      ).not.toContain(r.status);
    }
  });

  it('un cliente de B no se puede leer desde la ruta de A, ni al revés', async () => {
    const r1 = await call(app, 'GET', `/v1/orgs/${A.id}/customers/${seedCustomerId('cafe', 1)}`, A.owner.id);
    const r2 = await call(
      app,
      'GET',
      `/v1/orgs/${B.id}/customers/${seedCustomerId('barberia', 1)}`,
      B.owner.id,
    );
    expect([r1.status, r2.status]).toEqual([404, 404]);
  });

  it('el listado de clientes de A no contiene datos de otros negocios', async () => {
    const r = await call(app, 'GET', `/v1/orgs/${A.id}/customers?limit=100`, A.owner.id);
    const ids = (r.json.customers as { id: string }[]).map((c) => c.id);
    expect(ids.length).toBeGreaterThanOrEqual(A.customers);
    // Los tests de registro agregan clientes a este negocio: se compara contra la base, no contra un número fijo.
    const foreign = await withSystemTx(handle.db, (tx) =>
      tx
        .select({ id: schema.customers.id })
        .from(schema.customers)
        .where(and(inArray(schema.customers.id, ids), ne(schema.customers.organizationId, A.id))),
    );
    expect(foreign).toHaveLength(0);
  });

  it('un orgId mal formado → 404', async () => {
    expect((await call(app, 'GET', '/v1/orgs/no-es-uuid/customers', A.owner.id)).status).toBe(404);
  });
});

describe('roles', () => {
  it('el admin opera el negocio pero no ve la auditoría', async () => {
    expect((await call(app, 'GET', `/v1/orgs/${A.id}/customers`, A.admin.id)).status).toBe(200);
    const r = await call(app, 'GET', `/v1/orgs/${A.id}/audit`, A.admin.id);
    expect(r.status).toBe(403);
    expect(r.json.error?.code).toBe('forbidden');
  });

  it('el superadmin no lee clientes de un negocio (sin modo soporte)', async () => {
    expect((await call(app, 'GET', `/v1/orgs/${A.id}/customers`, SEED.superadmin.id)).status).toBe(404);
  });

  it('un dueño no accede al panel maestro', async () => {
    expect((await call(app, 'GET', '/v1/admin/orgs', A.owner.id)).status).toBe(404);
  });

  it('el superadmin ve el uso agregado de todos los negocios', async () => {
    const r = await call(app, 'GET', '/v1/admin/orgs', SEED.superadmin.id);
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(
      (r.json.organizations as { id: string; customers: number; walletPasses: number }[]).map((o) => [
        o.id,
        o,
      ]),
    );
    // Puede haber más negocios (los tests del ledger crean los suyos); los 3 del seed deben estar con sus datos.
    expect(Object.keys(byId)).toEqual(expect.arrayContaining([A.id, B.id, C.id]));
    const counts = await withSystemTx(handle.db, (tx) =>
      tx.execute(
        sql`select organization_id as id, count(*)::int as n from app.customers group by organization_id`,
      ),
    );
    const real = Object.fromEntries(
      (counts as unknown as { id: string; n: number }[]).map((r) => [r.id, r.n]),
    );
    for (const org of [A, B, C]) {
      expect(byId[org.id]!.customers).toBe(real[org.id]);
      expect(byId[org.id]!.customers).toBeGreaterThanOrEqual(org.customers);
    }
    expect(byId[A.id]!.walletPasses).toBe(5);
  });

  it('con MFA obligatorio, el superadmin necesita aal2 (TOTP)', async () => {
    const r1 = await call(
      strictApp,
      'GET',
      '/v1/admin/orgs',
      null,
      undefined,
      await token(SEED.superadmin.id, { aal: 'aal1' }),
    );
    expect(r1.status).toBe(403);
    expect(r1.json.error?.code).toBe('mfa_required');
    const r2 = await call(
      strictApp,
      'GET',
      '/v1/admin/orgs',
      null,
      undefined,
      await token(SEED.superadmin.id, { aal: 'aal2' }),
    );
    expect(r2.status).toBe(200);
  });
});

describe('suspensión de un negocio', () => {
  it('suspender bloquea el acceso sin borrar historial, queda auditado y se puede revertir', async () => {
    const before = await call(app, 'GET', `/v1/orgs/${C.id}`, C.owner.id);
    expect(before.status).toBe(200);

    expect(
      (
        await call(app, 'POST', `/v1/admin/orgs/${C.id}/suspend`, SEED.superadmin.id, {
          reason: 'Prueba de suspensión',
        })
      ).status,
    ).toBe(200);
    const blocked = await call(app, 'GET', `/v1/orgs/${C.id}/customers`, C.owner.id);
    expect(blocked.status).toBe(403);
    expect(blocked.json.error?.code).toBe('org_suspended');

    expect(
      (
        await call(app, 'POST', `/v1/admin/orgs/${C.id}/reactivate`, SEED.superadmin.id, {
          reason: 'Fin de la prueba',
        })
      ).status,
    ).toBe(200);
    const after = await call(app, 'GET', `/v1/orgs/${C.id}`, C.owner.id);
    expect(after.status).toBe(200);
    expect(after.json.stats).toEqual(before.json.stats);

    const audit = await call(app, 'GET', `/v1/orgs/${C.id}/audit`, C.owner.id);
    // Otras suites (caja) también escriben en la auditoría de este negocio: se miran solo las del negocio.
    expect(
      (audit.json.entries as { action: string }[]).map((e) => e.action).filter((a) => a.startsWith('org.')),
    ).toEqual(['org.reactivated', 'org.suspended']);
  });

  it('suspender exige motivo', async () => {
    expect((await call(app, 'POST', `/v1/admin/orgs/${C.id}/suspend`, SEED.superadmin.id, {})).status).toBe(
      400,
    );
  });
});

describe('fidelización vía API', () => {
  const cafe = `/v1/orgs/${B.id}`;
  const m = seedMembershipId('cafe', 5);

  it('suma, reintento idempotente, canje de catálogo y anulación del canje', async () => {
    const program = await call(app, 'GET', `${cafe}/program`, B.owner.id);
    const americano = (program.json.rewards as { id: string; name: string; cost: number }[]).find(
      (r) => r.cost === 50,
    )!;
    const before = (await call(app, 'GET', `${cafe}/memberships/${m}`, B.owner.id)).json.balance as number;

    const k = { 'idempotency-key': `earn_${randomUUID().replaceAll('-', '')}` };
    const e1 = await call(
      app,
      'POST',
      `${cafe}/memberships/${m}/earn`,
      B.owner.id,
      { amount: '60.00' },
      undefined,
      k,
    );
    expect(e1.status).toBe(201);
    expect((e1.json.membership as { balance: number }).balance).toBe(before + 60);
    const e2 = await call(
      app,
      'POST',
      `${cafe}/memberships/${m}/earn`,
      B.owner.id,
      { amount: '60.00' },
      undefined,
      k,
    );
    expect(e2.status).toBe(200);
    expect(e2.json.replayed).toBe(true);
    expect((e2.json.membership as { balance: number }).balance).toBe(before + 60);

    const r = await call(app, 'POST', `${cafe}/memberships/${m}/redeem`, B.owner.id, {
      rewardId: americano.id,
    });
    expect(r.status).toBe(201);
    expect((r.json.membership as { balance: number }).balance).toBe(before + 10);
    const redemptionId = (r.json.redemption as { id: string }).id;
    const v = await call(app, 'POST', `${cafe}/redemptions/${redemptionId}/void`, B.owner.id, {
      reason: 'Error de caja',
    });
    expect(v.status).toBe(201);
    expect((v.json.membership as { balance: number }).balance).toBe(before + 60);
  });

  it('errores de negocio → 409/422 con código legible', async () => {
    const noAmount = await call(app, 'POST', `${cafe}/memberships/${m}/earn`, B.owner.id, {});
    expect([noAmount.status, noAmount.json.error?.code]).toEqual([422, 'amount_required']);
    const program = await call(app, 'GET', `${cafe}/program`, B.owner.id);
    const postre = (program.json.rewards as { id: string; cost: number }[]).find((r) => r.cost === 120)!;
    const [poor] = await withSystemTx(handle.db, (tx) =>
      tx
        .select({ id: schema.memberships.id })
        .from(schema.memberships)
        .where(and(eq(schema.memberships.organizationId, B.id), sql`${schema.memberships.balance} < 120`))
        .limit(1),
    );
    const r = await call(app, 'POST', `${cafe}/memberships/${poor!.id}/redeem`, B.owner.id, {
      rewardId: postre.id,
    });
    expect([r.status, r.json.error?.code]).toEqual([409, 'insufficient_balance']);
    const noKey = await call(
      app,
      'POST',
      `${cafe}/memberships/${m}/earn`,
      B.owner.id,
      { amount: 10 },
      undefined,
      { 'idempotency-key': '' },
    );
    expect([noKey.status, noKey.json.error?.code]).toEqual([422, 'idempotency_key_required']);
    const badBody = await call(app, 'POST', `${cafe}/memberships/${m}/adjust`, B.owner.id, {
      delta: 'mucho',
      reason: 'x',
    });
    expect(badBody.status).toBe(400);
  });

  it('el admin de la barbería puede ajustar y anular cualquier movimiento; queda en la auditoría del dueño', async () => {
    const mb = seedMembershipId('barberia', 4);
    const adj = await call(app, 'POST', `/v1/orgs/${A.id}/memberships/${mb}/adjust`, A.admin.id, {
      delta: 2,
      reason: 'Compensación por demora',
    });
    expect(adj.status).toBe(201);
    const entryId = (adj.json.entries as { id: string; kind: string }[]).find((e) => e.kind === 'adjust')!.id;
    const v = await call(app, 'POST', `/v1/orgs/${A.id}/ledger/${entryId}/void`, A.admin.id, {
      reason: 'Ajuste duplicado',
    });
    expect(v.status).toBe(201);
    const audit = await call(app, 'GET', `/v1/orgs/${A.id}/audit`, A.owner.id);
    const actions = (audit.json.entries as { action: string }[]).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['ledger.adjusted', 'ledger.voided']));
  });

  it('reglas y premios: validación y versionado desde la API', async () => {
    const bad = await call(app, 'POST', `/v1/orgs/${C.id}/program/rules`, C.owner.id, {
      earnRule: { type: 'per_visit', units: 1 },
      goal: null,
    });
    expect([bad.status, bad.json.error?.code]).toEqual([422, 'invalid_rule']);
    const before = (await call(app, 'GET', `/v1/orgs/${C.id}/program`, C.owner.id)).json.rule as {
      version: number;
    };
    const ok = await call(app, 'POST', `/v1/orgs/${C.id}/program/rules`, C.owner.id, {
      earnRule: { type: 'per_visit', units: 1 },
      goal: 6,
      limits: { cooldown_minutes: 240, max_units_per_tx: 1, staff_daily_units: 200 },
    });
    expect(ok.status).toBe(201);
    expect((ok.json as { version: number }).version).toBe(before.version + 1);
    const catalogOnStamps = await call(app, 'POST', `/v1/orgs/${C.id}/rewards`, C.owner.id, {
      kind: 'catalog',
      name: 'X',
      cost: 5,
    });
    expect(catalogOnStamps.status).toBe(422);
  });
});
