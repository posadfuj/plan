/* eslint-disable @typescript-eslint/no-explicit-any -- script de demo: lee respuestas JSON de la API sin tipar */
/**
 * Demo de la semana 2 de Aiment Wallet: el motor de puntos y sellos por la API real.
 * Sellos (Veterinaria, meta 6) → premio → canje único → anulaciones; puntos (Café) → catálogo;
 * límites y override auditado; idempotencia y concurrencia; Wallet con una cola por proveedor.
 *
 * Requisitos: `pnpm local:setup`. Se puede ejecutar varias veces (elige clientes disponibles).
 */
import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { apiEnvSchema, parseEnv } from '@aiment/config';
import { createDb, schema, withSystemTx } from '@aiment/db';
import { SEED } from '@aiment/db/seed-data';
import { FakeWalletProvider } from '@aiment/wallet';
import { and, eq, sql } from 'drizzle-orm';
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
const section = (t: string) => console.log(`\n${bold(`━━ ${t}`)}`);
function check(step: string, ok: boolean, detail = '') {
  results.push({ step, ok });
  console.log(`  ${ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✖\x1b[0m'} ${step}${detail ? dim(`  ${detail}`) : ''}`);
}
const newKey = () => `demo_${randomUUID().replaceAll('-', '')}`;

async function login(email: string): Promise<string> {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: env.SEED_USER_PASSWORD }),
  });
  const json = (await res.json()) as { access_token?: string; msg?: string };
  if (!json.access_token) throw new Error(`Login fallido para ${email}: ${json.msg ?? res.status}`);
  return json.access_token;
}

const { db, close } = createDb(env.DATABASE_URL, { max: 20 });
const app = createApp({
  db,
  verifier: createSupabaseVerifier({ supabaseUrl: env.SUPABASE_URL, jwtSecret: env.SUPABASE_JWT_SECRET }),
  config: { requireSuperadminMfa: env.AUTH_REQUIRE_SUPERADMIN_MFA },
});
const port = 8798;
const server = serve({ fetch: app.fetch, port });
const api = async (method: string, path: string, token: string, body?: unknown, key = newKey()) => {
  const res = await fetch(`http://localhost:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'idempotency-key': key },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: res.status,
    replayed: res.headers.get('idempotent-replayed') === 'true',
    json: (await res.json()) as any,
  };
};

// Wallet simulado en el mismo proceso: una cola por proveedor.
const walletLog: string[] = [];
const google = new FakeWalletProvider('google', { log: (m) => walletLog.push(m) });
const apple = new FakeWalletProvider('apple', { log: (m) => walletLog.push(m) });
const worker = await startWorker({
  databaseUrl: env.DATABASE_URL,
  db,
  providers: [google, apple],
  publicBaseUrl: env.PUBLIC_BASE_URL,
  debounceSeconds: 0,
  pollSeconds: 0.5,
  retry: { limit: 3, delaySeconds: 1, backoff: false },
});

try {
  console.log(bold('\nAiment Wallet · Demo semana 2 · Motor de puntos y sellos'));
  const tk = {
    vet: await login(C.owner.email),
    cafe: await login(B.owner.email),
    barberia: await login(A.owner.email),
    adminBarberia: await login(A.admin.email),
  };

  // --- 1. Sellos -------------------------------------------------------------
  section('1. Sellos: Veterinaria Patitas (6 sellos = baño gratis)');
  const vet = `/v1/orgs/${C.id}`;
  const program = await api('GET', `${vet}/program`, tk.vet);
  check(
    `Regla vigente v${program.json.rule.version}: 1 visita = ${program.json.rule.earnRule.units} sello, meta ${program.json.rule.goal}`,
    program.status === 200,
    `cooldown ${program.json.rule.limits.cooldown_minutes} min · premio "${program.json.rewards.find((r: any) => r.kind === 'goal').name}"`,
  );
  // Cliente sin sumas en las últimas 4 h (cooldown); se deja en 5 sellos con un ajuste auditado si hace falta.
  const [client] = await withSystemTx(db, (tx) =>
    tx
      .select({
        id: schema.memberships.id,
        balance: schema.memberships.balance,
        name: schema.customers.fullName,
      })
      .from(schema.memberships)
      .innerJoin(schema.customers, eq(schema.customers.id, schema.memberships.customerId))
      .where(
        and(
          eq(schema.memberships.organizationId, C.id),
          sql`not exists (select 1 from app.ledger_entries l where l.membership_id = ${schema.memberships.id}
                and l.kind = 'earn' and l.created_at > now() - interval '4 hours'
                and not exists (select 1 from app.ledger_entries r where r.reverses_entry_id = l.id))`,
        ),
      )
      .orderBy(sql`abs(${schema.memberships.balance} - 5)`)
      .limit(1),
  );
  const m = `${vet}/memberships/${client!.id}`;
  if (client!.balance !== 5) {
    const adj = await api('POST', `${m}/adjust`, tk.vet, {
      delta: 5 - client!.balance,
      reason: 'Preparación de la demo',
    });
    check(`Preparación: ajuste auditado de ${client!.name} a 5 sellos`, adj.status === 201);
  }
  console.log(dim(`     Cliente: ${client!.name} · 5 de 6 sellos`));

  const visit = await api('POST', `${m}/earn`, tk.vet, {});
  const earned = visit.json.earnedRewards?.[0];
  check(
    'Visita 6 → se completa la meta: premio ganado y la tarjeta vuelve a 0',
    visit.status === 201 && visit.json.membership.balance === 0 && earned?.source === 'goal',
    visit.json.entries
      ?.map((e: any) => `${e.kind} ${e.delta > 0 ? '+' : ''}${e.delta} → ${e.balanceAfter}`)
      .join(' · '),
  );
  const again = await api('POST', `${m}/earn`, tk.vet, {});
  check(
    'Otra suma al instante → bloqueada por cooldown',
    again.status === 409 && again.json.error.code === 'cooldown_active',
    again.json.error?.message,
  );

  const r1 = await api('POST', `${m}/redeem`, tk.vet, { earnedRewardId: earned.id });
  check(`Canje de "${earned.name}"`, r1.status === 201 && r1.json.redemption.status === 'completed');
  const r2 = await api('POST', `${m}/redeem`, tk.vet, { earnedRewardId: earned.id });
  check(
    'El mismo premio no se puede canjear dos veces',
    r2.status === 409 && r2.json.error.code === 'reward_not_available',
  );

  const blocked = await api('POST', `${vet}/ledger/${visit.json.entries[0].id}/void`, tk.vet, {
    reason: 'Prueba',
  });
  check(
    'Anular la visita que dio el premio ya canjeado → bloqueado',
    blocked.status === 409 && blocked.json.error.code === 'reward_already_redeemed',
    blocked.json.error?.message,
  );
  const unredeem = await api('POST', `${vet}/redemptions/${r1.json.redemption.id}/void`, tk.vet, {
    reason: 'Canje por error',
  });
  check(
    'Anular el canje → el premio vuelve a estar disponible',
    unredeem.status === 201 && unredeem.json.membership.availableRewards.length >= 1,
  );
  const unvisit = await api('POST', `${vet}/ledger/${visit.json.entries[0].id}/void`, tk.vet, {
    reason: 'Visita registrada por error',
  });
  check(
    'Anular la visita → se revierten la visita, la conversión y el premio; vuelve a 5 sellos',
    unvisit.status === 201 &&
      unvisit.json.membership.balance === 5 &&
      unvisit.json.earnedRewards[0]?.status === 'voided',
    unvisit.json.entries?.map((e: any) => `reversa ${e.delta > 0 ? '+' : ''}${e.delta}`).join(' · '),
  );
  const twice = await api('POST', `${vet}/ledger/${visit.json.entries[0].id}/void`, tk.vet, {
    reason: 'Otra vez',
  });
  check(
    'Un movimiento no se anula dos veces',
    twice.status === 409 && twice.json.error.code === 'already_voided',
  );

  // --- 2. Puntos -------------------------------------------------------------
  section('2. Puntos: Café Aroma (S/1 = 1 punto, catálogo)');
  const cafe = `/v1/orgs/${B.id}`;
  const cafeProgram = await api('GET', `${cafe}/program`, tk.cafe);
  const catalog = cafeProgram.json.rewards.filter((r: any) => r.kind === 'catalog');
  console.log(dim(`     Catálogo: ${catalog.map((r: any) => `${r.name} (${r.cost} pts)`).join(' · ')}`));
  const cm = `${cafe}/memberships/${await firstMembership(B.id)}`;
  const before = (await api('GET', cm, tk.cafe)).json.balance;
  const buy = await api('POST', `${cm}/earn`, tk.cafe, { amount: '45.90' });
  check(
    'Compra de S/ 45.90 → +45 puntos (redondeo hacia abajo)',
    buy.status === 201 && buy.json.membership.balance === before + 45,
    `saldo ${before} → ${buy.json.membership.balance}`,
  );
  const noAmount = await api('POST', `${cm}/earn`, tk.cafe, {});
  check(
    'Sin monto → 422 con mensaje claro',
    noAmount.status === 422 && noAmount.json.error.code === 'amount_required',
    noAmount.json.error.message,
  );
  const americano = catalog.find((r: any) => r.cost === 50);
  const balanceNow = buy.json.membership.balance;
  if (balanceNow < 50) await api('POST', `${cm}/earn`, tk.cafe, { amount: 50 });
  const red = await api('POST', `${cm}/redeem`, tk.cafe, { rewardId: americano.id });
  check(
    `Canje de "${americano.name}" descuenta 50 puntos`,
    red.status === 201 && red.json.entries[0].delta === -50,
    `saldo → ${red.json.membership.balance}`,
  );
  const back = await api('POST', `${cafe}/redemptions/${red.json.redemption.id}/void`, tk.cafe, {
    reason: 'Cliente cambió de opinión',
  });
  check(
    'Anular el canje devuelve los puntos',
    back.status === 201 && back.json.membership.balance === red.json.membership.balance + 50,
  );

  // --- 3. Límites y override ---------------------------------------------------
  section('3. Límites anti-fraude y override auditado (Barbería)');
  const [bm] = await withSystemTx(db, (tx) =>
    tx.execute(sql`select m.id from app.memberships m where m.organization_id = ${A.id}
      and not exists (select 1 from app.ledger_entries l where l.membership_id = m.id and l.kind = 'earn'
        and l.created_at > now() - interval '4 hours'
        and not exists (select 1 from app.ledger_entries r where r.reverses_entry_id = l.id)) limit 1`),
  );
  const bmPath = `/v1/orgs/${A.id}/memberships/${(bm as any).id}`;
  await api('POST', `${bmPath}/earn`, tk.barberia, {});
  const cool = await api('POST', `${bmPath}/earn`, tk.barberia, {});
  check(
    'Segunda suma dentro de 4 h → bloqueada, indica desde cuándo reintentar',
    cool.status === 409 && !!cool.json.error.details.violations[0].retryAt,
    `reintentar desde ${cool.json.error.details.violations?.[0]?.retryAt}`,
  );
  const over = await api('POST', `${bmPath}/earn`, tk.barberia, {
    overrideReason: 'Dos servicios en la misma visita',
  });
  check(
    'El dueño la autoriza con motivo → pasa y queda en la auditoría',
    over.status === 201 && over.json.overriddenLimits.includes('cooldown_active'),
  );
  const audit = await api('GET', `/v1/orgs/${A.id}/audit`, tk.barberia);
  check(
    'Auditoría del dueño registra el override',
    audit.json.entries.some((e: any) => e.action === 'limits.overridden'),
  );
  const adminAdj = await api('POST', `${bmPath}/adjust`, tk.adminBarberia, {
    delta: -1,
    reason: 'Corrección del override',
  });
  check('El admin corrige con un ajuste negativo (nunca se edita el pasado)', adminAdj.status === 201);

  // --- 4. Idempotencia y concurrencia -----------------------------------------
  section('4. Idempotencia y concurrencia');
  const fixedKey = newKey();
  const ok1 = await api('POST', `${cm}/earn`, tk.cafe, { amount: 10 }, fixedKey);
  const ok2 = await api('POST', `${cm}/earn`, tk.cafe, { amount: 10 }, fixedKey);
  check(
    'Reintento con la misma clave → 200 "replayed", mismo movimiento, sin duplicar',
    ok1.status === 201 &&
      ok2.status === 200 &&
      ok2.replayed &&
      ok2.json.entries[0].id === ok1.json.entries[0].id,
  );
  const base = ok2.json.membership.balance;
  const burstKey = newKey();
  const burst = await Promise.all(
    Array.from({ length: 10 }, () => api('POST', `${cm}/earn`, tk.cafe, { amount: 10 }, burstKey)),
  );
  const afterBurst = (await api('GET', cm, tk.cafe)).json.balance;
  check(
    '10 envíos simultáneos con la misma clave (doble clic/red lenta) → 1 solo movimiento',
    afterBurst === base + 10 && burst.filter((r) => r.status === 201).length === 1,
  );
  const parallel = await Promise.all(
    Array.from({ length: 20 }, () => api('POST', `${cm}/earn`, tk.cafe, { amount: 5 })),
  );
  const afterParallel = (await api('GET', cm, tk.cafe)).json.balance;
  check(
    '20 compras distintas simultáneas → saldo exacto (+100)',
    parallel.every((r) => r.status === 201) && afterParallel === afterBurst + 100,
    `saldo ${afterBurst} → ${afterParallel}`,
  );
  const [sum] = await withSystemTx(db, (tx) =>
    tx.execute(
      sql`select count(*)::int as bad from (select m.id from app.memberships m left join app.ledger_entries l on l.membership_id = m.id group by m.id, m.balance having m.balance <> coalesce(sum(l.delta),0)) x`,
    ),
  );
  check('En toda la base, cada saldo coincide con la suma de sus movimientos', (sum as any).bad === 0);

  // --- 5. Wallet ---------------------------------------------------------------
  section('5. Wallet simulado: una cola por proveedor');
  const [withPasses] = await withSystemTx(db, (tx) =>
    tx
      .select({ id: schema.walletPasses.membershipId })
      .from(schema.walletPasses)
      .where(
        and(
          eq(schema.walletPasses.organizationId, B.id),
          eq(schema.walletPasses.provider, 'apple'),
          sql`${schema.walletPasses.membershipId} <> ${cm.split('/').at(-1)}`,
        ),
      )
      .limit(1),
  );
  await new Promise((r) => setTimeout(r, 2500)); // deja terminar las sincronizaciones de las secciones anteriores
  const mine = (p: FakeWalletProvider) => p.calls.filter((c) => c.membershipId === withPasses!.id).length;
  google.failNext(1);
  const g0 = mine(google);
  const a0 = mine(apple);
  const walletEarn = await api('POST', `${cafe}/memberships/${withPasses!.id}/earn`, tk.cafe, { amount: 20 });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !(mine(google) > g0 && mine(apple) > a0))
    await new Promise((r) => setTimeout(r, 250));
  await new Promise((r) => setTimeout(r, 1500));
  for (const l of walletLog.slice(-4)) console.log(dim(`     ${l}`));
  const lastGoogle = google.calls.filter((c) => c.membershipId === withPasses!.id).at(-1);
  check(
    'La suma llegó a los pases Google y Apple con el saldo de la base',
    lastGoogle?.balance === walletEarn.json.membership.balance,
  );
  check(
    'Google falló una vez y se reintentó solo; Apple se sincronizó una sola vez',
    mine(google) === g0 + 1 && mine(apple) === a0 + 1,
    `llamadas nuevas: Google ${mine(google) - g0} (tras 1 fallo) · Apple ${mine(apple) - a0}`,
  );
} catch (err) {
  console.error('\n✖ La demo se detuvo:', err instanceof Error ? err.message : err);
  console.error('  ¿Está corriendo Supabase local? Ejecuta `pnpm local:setup` y vuelve a intentar.');
  process.exitCode = 1;
} finally {
  const failed = results.filter((r) => !r.ok);
  console.log(
    bold(`\nResultado: ${results.length - failed.length}/${results.length} verificaciones correctas`),
  );
  if (failed.length) process.exitCode = 1;
  await worker.stop();
  server.close();
  await close();
}

async function firstMembership(orgId: string): Promise<string> {
  const [row] = await withSystemTx(db, (tx) =>
    tx
      .select({ id: schema.memberships.id })
      .from(schema.memberships)
      .where(eq(schema.memberships.organizationId, orgId))
      .limit(1),
  );
  return row!.id;
}
