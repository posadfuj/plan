/**
 * Suite de aislamiento y roles a nivel de API (primera capa).
 * Tokens firmados como los emite Supabase Auth (HS256 local); base de test aiment_test.
 */
import { createDb, type DbHandle } from '@aiment/db';
import { SEED, seedCustomerId } from '@aiment/db/seed-data';
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
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const t = tk ?? (userId ? await token(userId) : undefined);
  if (t) headers.authorization = `Bearer ${t}`;
  const res = await target.request(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown> & { error?: { code: string } },
  };
}

/** Todas las rutas de un negocio, con recursos del negocio A. Cualquier ruta nueva debe agregarse aquí. */
const ORG_ENDPOINTS = [
  { method: 'GET', path: `/v1/orgs/${A.id}`, pattern: '/v1/orgs/:orgId' },
  { method: 'GET', path: `/v1/orgs/${A.id}/customers`, pattern: '/v1/orgs/:orgId/customers' },
  {
    method: 'GET',
    path: `/v1/orgs/${A.id}/customers/${seedCustomerId('barberia', 1)}`,
    pattern: '/v1/orgs/:orgId/customers/:customerId',
  },
  { method: 'GET', path: `/v1/orgs/${A.id}/audit`, pattern: '/v1/orgs/:orgId/audit' },
];

beforeAll(() => {
  handle = createDb(inject('apiDbUrl'), { max: 5 });
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
    const covered = new Set(ORG_ENDPOINTS.map((e) => `${e.method} ${e.pattern}`));
    expect([...appRoutes].filter((r) => !covered.has(r))).toEqual([]);
  });

  it('el dueño de A accede a todas las rutas de su negocio', async () => {
    for (const e of ORG_ENDPOINTS)
      expect((await call(app, e.method, e.path, A.owner.id)).status, e.path).toBe(200);
  });

  it('el dueño de B recibe 404 en TODAS las rutas del negocio A (no se revela que existe)', async () => {
    for (const e of ORG_ENDPOINTS) {
      const r = await call(app, e.method, e.path, B.owner.id);
      expect(r.status, e.path).toBe(404);
      expect(r.json.error?.code).toBe('not_found');
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
    expect(ids).toHaveLength(A.customers);
    expect(ids.every((id) => id.startsWith('00000000-0000-4000-8000-00000010a'))).toBe(true);
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
    expect(Object.keys(byId)).toHaveLength(3);
    expect(byId[A.id]).toMatchObject({ customers: A.customers, walletPasses: 5 });
    expect(byId[B.id]).toMatchObject({ customers: B.customers });
    expect(byId[C.id]).toMatchObject({ customers: C.customers });
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
    expect((audit.json.entries as { action: string }[]).map((e) => e.action)).toEqual([
      'org.reactivated',
      'org.suspended',
    ]);
  });

  it('suspender exige motivo', async () => {
    expect((await call(app, 'POST', `/v1/admin/orgs/${C.id}/suspend`, SEED.superadmin.id, {})).status).toBe(
      400,
    );
  });
});
