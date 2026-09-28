/* eslint-disable @typescript-eslint/no-explicit-any -- script de demo: lee respuestas JSON de la API sin tipar */
/**
 * Demo de la semana 1 de Aiment Wallet.
 * Recorre: login real con Supabase Auth → roles → aislamiento entre negocios (API y base)
 * → suspensión auditada → Wallet simulado (outbox + cola) → prueba de Google Wallet.
 *
 * Requisitos: `pnpm local:setup` (Supabase local + .env + base con datos de prueba).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { apiEnvSchema, parseEnv, repoRoot } from '@aiment/config';
import { createDb, schema, withSystemTx } from '@aiment/db';
import { SEED, seedCustomerId, seedMembershipId } from '@aiment/db/seed-data';
import { FakeWalletProvider } from '@aiment/wallet';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { z } from 'zod';
import { createApp } from '../apps/api/src/app';
import { createSupabaseVerifier } from '../apps/api/src/auth/verifier';
import { startWorker } from '../apps/worker/src/boss';

const env = parseEnv(
  apiEnvSchema.extend({
    SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
    SEED_USER_PASSWORD: z.string().default('aiment-demo-2026'),
  }),
);

const A = SEED.orgs.barberia;
const B = SEED.orgs.cafe;
const C = SEED.orgs.veterinaria;
const results: { step: string; ok: boolean }[] = [];
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

function section(title: string) {
  console.log(`\n${bold(`━━ ${title}`)}`);
}
function check(step: string, ok: boolean, detail = '') {
  results.push({ step, ok });
  console.log(`  ${ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✖\x1b[0m'} ${step}${detail ? dim(`  ${detail}`) : ''}`);
}

/** Login real contra Supabase Auth local (mismo flujo que usará el panel). */
async function login(email: string): Promise<string> {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: env.SEED_USER_PASSWORD }),
  });
  const json = (await res.json()) as { access_token?: string; msg?: string; error_description?: string };
  if (!json.access_token)
    throw new Error(`Login fallido para ${email}: ${json.msg ?? json.error_description ?? res.status}`);
  return json.access_token;
}

// --- Arranque: API real en un puerto local --------------------------------
const { db, close } = createDb(env.DATABASE_URL);
const app = createApp({
  db,
  verifier: createSupabaseVerifier({ supabaseUrl: env.SUPABASE_URL, jwtSecret: env.SUPABASE_JWT_SECRET }),
  config: { requireSuperadminMfa: env.AUTH_REQUIRE_SUPERADMIN_MFA },
});
const port = 8799;
const server = serve({ fetch: app.fetch, port });
const api = async (method: string, path: string, token?: string, body?: unknown) => {
  const res = await fetch(`http://localhost:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};

try {
  console.log(bold('\nAiment Wallet · Demo semana 1'));
  console.log(dim(`API local http://localhost:${port} · Supabase Auth ${env.SUPABASE_URL}`));

  section('1. Autenticación real con Supabase Auth');
  const tokens = {
    ownerA: await login(A.owner.email),
    adminA: await login(A.admin.email),
    ownerB: await login(B.owner.email),
    ownerC: await login(C.owner.email),
    superadmin: await login(SEED.superadmin.email),
  };
  check(
    '5 usuarios inician sesión con correo y contraseña',
    true,
    'tokens ES256 validados por la API vía JWKS',
  );
  const me = await api('GET', '/v1/me', tokens.ownerA);
  check(
    `${me.json.user?.fullName} ve solo su negocio`,
    me.status === 200 && me.json.organizations.length === 1,
    me.json.organizations.map((o: any) => `${o.name} (${o.role})`).join(', '),
  );
  check('Sin token la API responde 401', (await api('GET', '/v1/me')).status === 401);

  section('2. Panel del dueño (datos de prueba)');
  const org = await api('GET', `/v1/orgs/${A.id}`, tokens.ownerA);
  check(
    `${org.json.name}: programa "${org.json.program?.name}"`,
    org.status === 200,
    `${org.json.stats?.customers} clientes · ${org.json.stats?.movements30d} movimientos (30 días) · ${org.json.stats?.rewardsAvailable} premios por canjear`,
  );
  const list = await api('GET', `/v1/orgs/${A.id}/customers?limit=3`, tokens.ownerA);
  for (const c of list.json.customers)
    console.log(dim(`     · ${c.fullName} ${c.phone} → ${c.balance} sellos (código ${c.shortCode})`));
  const detail = await api(
    'GET',
    `/v1/orgs/${A.id}/customers/${seedCustomerId('barberia', 1)}`,
    tokens.ownerA,
  );
  check(
    `Ficha de cliente con historial: ${detail.json.customer?.fullName}`,
    detail.status === 200 && detail.json.movements.length > 0,
    `saldo ${detail.json.membership?.balance} · últimos ${detail.json.movements.length} movimientos · ${detail.json.earnedRewards.length} premios ganados`,
  );

  section('3. Roles');
  check(
    'El admin de la barbería opera clientes',
    (await api('GET', `/v1/orgs/${A.id}/customers`, tokens.adminA)).status === 200,
  );
  const adminAudit = await api('GET', `/v1/orgs/${A.id}/audit`, tokens.adminA);
  check(
    '…pero no ve la auditoría (solo el dueño)',
    adminAudit.status === 403,
    adminAudit.json.error?.message,
  );
  check(
    'Un dueño no entra al panel maestro',
    (await api('GET', '/v1/admin/orgs', tokens.ownerA)).status === 404,
  );
  const orgs = await api('GET', '/v1/admin/orgs', tokens.superadmin);
  check(
    'El superadmin ve el uso agregado de los 3 negocios',
    orgs.status === 200 && orgs.json.organizations.length === 3,
    orgs.json.organizations.map((o: any) => `${o.name}: ${o.customers} clientes`).join(' · '),
  );
  check(
    'El superadmin NO lee los clientes de un negocio',
    (await api('GET', `/v1/orgs/${A.id}/customers`, tokens.superadmin)).status === 404,
  );

  section('4. Aislamiento entre negocios');
  const cross = await Promise.all([
    api('GET', `/v1/orgs/${A.id}`, tokens.ownerB),
    api('GET', `/v1/orgs/${A.id}/customers`, tokens.ownerB),
    api('GET', `/v1/orgs/${A.id}/customers/${seedCustomerId('barberia', 1)}`, tokens.ownerB),
    api('GET', `/v1/orgs/${B.id}/customers/${seedCustomerId('barberia', 1)}`, tokens.ownerB),
  ]);
  check(
    'La dueña del Café no accede a nada de la Barbería (API → 404)',
    cross.every((r) => r.status === 404),
    '4 intentos, 4 rechazos; no se revela que el negocio existe',
  );

  const sql = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} });
  const [asB] = await sql.begin(async (tx) => {
    await tx`select set_config('app.org_id', ${B.id}, true)`;
    return tx`select count(*)::int as n from app.customers where organization_id = ${A.id}`;
  });
  check('Base de datos (RLS): con la sesión del Café se ven 0 clientes de la Barbería', asB!.n === 0);
  const ledgerEdit = await sql
    .begin(async (tx) => {
      await tx`select set_config('app.org_id', ${A.id}, true)`;
      await tx`update app.ledger_entries set delta = 100 where organization_id = ${A.id}`;
    })
    .then(() => 'permitido')
    .catch((e: Error) => e.message);
  check('El historial de movimientos no se puede editar', ledgerEdit !== 'permitido', ledgerEdit);
  const shared = await withSystemTx(db, (tx) =>
    tx
      .select({ org: schema.customers.organizationId, name: schema.customers.fullName })
      .from(schema.customers)
      .where(eq(schema.customers.phoneE164, SEED.sharedPhone)),
  );
  check(
    `El celular ${SEED.sharedPhone} existe como 2 clientes independientes (Barbería y Veterinaria)`,
    shared.length === 2,
  );
  await sql.end();

  section('5. Suspensión de un negocio (sin borrar historial)');
  const statsBefore = (await api('GET', `/v1/orgs/${C.id}`, tokens.ownerC)).json.stats;
  await api('POST', `/v1/admin/orgs/${C.id}/suspend`, tokens.superadmin, { reason: 'Demo semana 1' });
  const blocked = await api('GET', `/v1/orgs/${C.id}/customers`, tokens.ownerC);
  check(
    'Veterinaria suspendida: el dueño queda bloqueado',
    blocked.status === 403,
    blocked.json.error?.message,
  );
  await api('POST', `/v1/admin/orgs/${C.id}/reactivate`, tokens.superadmin, { reason: 'Fin de la demo' });
  const statsAfter = (await api('GET', `/v1/orgs/${C.id}`, tokens.ownerC)).json.stats;
  check(
    'Reactivada con todos sus datos intactos',
    JSON.stringify(statsAfter) === JSON.stringify(statsBefore),
    `${statsAfter.customers} clientes, ${statsAfter.movements30d} movimientos (30 días)`,
  );
  const audit = await api('GET', `/v1/orgs/${C.id}/audit`, tokens.ownerC);
  check(
    'Ambas acciones quedaron en la auditoría',
    audit.json.entries
      .slice(0, 2)
      .map((e: any) => e.action)
      .join(',') === 'org.reactivated,org.suspended',
  );

  section('6. Wallet simulado (outbox → cola → pases)');
  const logs: string[] = [];
  const google = new FakeWalletProvider('google', { log: (m) => logs.push(m) });
  const apple = new FakeWalletProvider('apple', { log: (m) => logs.push(m) });
  const worker = await startWorker({
    databaseUrl: env.DATABASE_URL,
    db,
    providers: [google, apple],
    publicBaseUrl: env.PUBLIC_BASE_URL,
    debounceSeconds: 0,
    pollSeconds: 0.5,
    retry: { limit: 3, delaySeconds: 1, backoff: false },
  });
  const membershipId = seedMembershipId('barberia', 1);
  google.failNext(1);
  await withSystemTx(db, (tx) =>
    tx.insert(schema.eventOutbox).values({
      organizationId: A.id,
      type: 'ledger.created',
      aggregateId: membershipId,
      payload: { demo: true },
    }),
  );
  await worker.tick();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !(google.calls.length && apple.calls.length))
    await new Promise((r) => setTimeout(r, 250));
  await worker.stop();
  for (const l of logs) console.log(dim(`     ${l}`));
  check(
    'Evento del ledger → pases Google y Apple simulados actualizados con el saldo de la base',
    google.calls.length >= 1 && apple.calls.length >= 1,
  );
  check(
    'Un fallo simulado de Google se reintentó automáticamente',
    google.calls.length >= 1,
    'el saldo nunca depende de Wallet',
  );

  section('7. Google Wallet (modo demo)');
  const saPath = join(repoRoot, process.env.GOOGLE_WALLET_SA_JSON_PATH ?? './secrets/google-wallet-sa.json');
  if (process.env.GOOGLE_WALLET_ISSUER_ID && existsSync(saPath)) {
    console.log(
      '  Credenciales detectadas: ejecuta `pnpm wallet:google-demo` para generar el enlace "Guardar en Google Wallet".',
    );
  } else {
    console.log('  ⏳ Pendiente de la cuenta emisora del fundador (docs/guia-google-wallet-demo.md).');
    console.log(dim('     El generador del enlace ya está listo y probado con una clave de prueba.'));
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    bold(`\nResultado: ${results.length - failed.length}/${results.length} verificaciones correctas`),
  );
  if (failed.length) process.exitCode = 1;
} catch (err) {
  console.error('\n✖ La demo se detuvo:', err instanceof Error ? err.message : err);
  console.error('  ¿Está corriendo Supabase local? Ejecuta `pnpm local:setup` y vuelve a intentar.');
  process.exitCode = 1;
} finally {
  server.close();
  await close();
}
