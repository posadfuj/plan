/**
 * Operaciones de administración de base de datos: migraciones, roles, reset y seed.
 * Se ejecutan con DATABASE_ADMIN_URL (nunca desde la API).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash as argon2Hash } from '@node-rs/argon2';
import { createClient } from '@supabase/supabase-js';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { PgBoss } from 'pg-boss';
import { createDb, type Tx } from './client';
import * as s from './schema';
import { SEED, type SeedOrgKey, seedCustomerId, seedMembershipId, seedUsers } from './seed-data';

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function runMigrations(adminUrl: string): Promise<void> {
  const h = createDb(adminUrl, { max: 1 });
  try {
    await migrate(h.db, { migrationsFolder, migrationsSchema: 'drizzle' });
  } finally {
    await h.close();
  }
  await installJobQueue(adminUrl);
}

/**
 * Instala o actualiza el esquema de pg-boss con el usuario administrador y da a app_api
 * permisos de uso de datos. El worker arranca con `migrate: false`: nunca crea estructuras.
 */
export async function installJobQueue(adminUrl: string): Promise<void> {
  const boss = new PgBoss({
    connectionString: adminUrl,
    schema: 'pgboss',
    supervise: false,
    schedule: false,
    max: 1,
  });
  boss.on('error', () => {});
  await boss.start();
  await boss.stop({ graceful: false, timeout: 1000 });
  const h = createDb(adminUrl, { max: 1 });
  try {
    await h.sql.unsafe(`
      GRANT USAGE ON SCHEMA pgboss TO app_api;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO app_api;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO app_api;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO app_api;
      ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_api;
      ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT USAGE, SELECT ON SEQUENCES TO app_api;
      ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT EXECUTE ON FUNCTIONS TO app_api;`);
  } finally {
    await h.close();
  }
}

/** Crea o actualiza el usuario con login de la API, miembro de app_api (sin BYPASSRLS). */
export async function ensureAppRole(adminUrl: string, user: string, password: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{2,62}$/.test(user)) throw new Error(`Nombre de rol inválido: ${user}`);
  const lit = `'${password.replaceAll("'", "''")}'`;
  const h = createDb(adminUrl, { max: 1 });
  try {
    const [row] = await h.sql`select 1 from pg_roles where rolname = ${user}`;
    await h.sql.unsafe(
      row
        ? `ALTER ROLE ${user} LOGIN NOBYPASSRLS PASSWORD ${lit}`
        : `CREATE ROLE ${user} LOGIN NOBYPASSRLS PASSWORD ${lit}`,
    );
    await h.sql.unsafe(`GRANT app_api TO ${user}`);
  } finally {
    await h.close();
  }
}

/** Borra TODO el estado de la aplicación (solo entornos locales y de test). */
export async function resetDatabase(adminUrl: string): Promise<void> {
  const h = createDb(adminUrl, { max: 1 });
  try {
    await h.sql.unsafe(
      'DROP SCHEMA IF EXISTS app CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE;',
    );
  } finally {
    await h.close();
  }
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------
const FIRST = [
  'Ana',
  'Luis',
  'María',
  'José',
  'Carmen',
  'Jorge',
  'Rosa',
  'Miguel',
  'Lucía',
  'Diego',
  'Elena',
  'Raúl',
  'Patricia',
  'Víctor',
  'Sandra',
];
const LAST = [
  'Quispe',
  'Flores',
  'Sánchez',
  'Rojas',
  'Díaz',
  'Torres',
  'Vargas',
  'Ramírez',
  'Castillo',
  'Chávez',
  'Huamán',
  'Mendoza',
];
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const SHORT = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** Token de 128 bits en base62 (mismo formato que usará la API). */
export function newToken(): string {
  let n = BigInt('0x' + randomBytes(16).toString('hex'));
  let out = '';
  while (n > 0n) {
    out = BASE62[Number(n % 62n)] + out;
    n /= 62n;
  }
  return out.padStart(22, '0');
}

/** PRNG determinista para que el seed produzca siempre el mismo historial. */
function prng(seed: string) {
  let x = createHash('sha256').update(seed).digest().readUInt32LE(0) || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 1_000_000) / 1_000_000;
  };
}

function shortCode(rand: () => number): string {
  return Array.from({ length: 6 }, () => SHORT[Math.floor(rand() * SHORT.length)]).join('');
}

export interface SeedOptions {
  /** Si se entregan, se crean/actualizan los usuarios en Supabase Auth con los mismos IDs. */
  auth?: { supabaseUrl: string; secretKey: string; password: string };
  log?: (msg: string) => void;
}

export async function seedDatabase(adminUrl: string, opts: SeedOptions = {}): Promise<void> {
  const log = opts.log ?? (() => {});
  if (opts.auth) {
    await seedAuthUsers(opts.auth);
    log(`Usuarios de Supabase Auth listos (${seedUsers().length}).`);
  } else {
    log('Sin SUPABASE_SECRET_KEY: se omite Supabase Auth (modo CI).');
  }

  const h = createDb(adminUrl, { max: 1 });
  try {
    await h.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.scope', 'system', true)`);
      await seedPlatform(tx);
      for (const key of Object.keys(SEED.orgs) as SeedOrgKey[]) {
        const n = await seedOrg(tx, key);
        log(
          `${SEED.orgs[key].name}: ${n.customers} clientes, ${n.entries} movimientos, ${n.earned} premios ganados, ${n.redeemed} canjes.`,
        );
      }
    });
  } finally {
    await h.close();
  }
}

async function seedAuthUsers(auth: NonNullable<SeedOptions['auth']>) {
  const sb = createClient(auth.supabaseUrl, auth.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  for (const user of seedUsers()) {
    const existing = await sb.auth.admin.getUserById(user.id);
    if (existing.data.user) {
      const { error } = await sb.auth.admin.updateUserById(user.id, {
        password: auth.password,
        email_confirm: true,
      });
      if (error) throw new Error(`Supabase Auth (${user.email}): ${error.message}`);
    } else {
      const { error } = await sb.auth.admin.createUser({
        id: user.id,
        email: user.email,
        password: auth.password,
        email_confirm: true,
        user_metadata: { full_name: user.name },
      });
      if (error) throw new Error(`Supabase Auth (${user.email}): ${error.message}`);
    }
  }
}

const LEGAL_DRAFT =
  '**BORRADOR** — texto provisional pendiente de revisión legal (Ley 29733). No usar con clientes reales.';

async function seedPlatform(tx: Tx) {
  await tx
    .insert(s.plans)
    .values([
      {
        code: 'start',
        name: 'Start',
        limits: { branches: 1, staff: 3 },
        features: { automations: false, csv: true },
      },
      {
        code: 'pro',
        name: 'Pro',
        limits: { branches: 1, staff: 10 },
        features: { automations: true, csv: true },
      },
      {
        code: 'multi',
        name: 'Multi',
        limits: { branches: 10, staff: 50 },
        features: { automations: true, csv: true },
      },
    ])
    .onConflictDoNothing();

  for (const kind of ['terms', 'privacy', 'marketing'] as const) {
    await tx
      .insert(s.consentVersions)
      .values({ kind, version: 1, bodyMd: LEGAL_DRAFT })
      .onConflictDoNothing();
  }

  for (const user of seedUsers()) {
    await tx
      .insert(s.users)
      .values({ id: user.id, email: user.email, fullName: user.name, isSuperadmin: user.superadmin })
      .onConflictDoNothing();
  }
}

async function seedOrg(tx: Tx, key: SeedOrgKey) {
  const o = SEED.orgs[key];
  const stamps = key !== 'cafe';
  const goal = key === 'barberia' ? 10 : 6;
  const rand = prng(o.slug);

  await tx.insert(s.organizations).values({
    id: o.id,
    slug: o.slug,
    name: o.name,
    category: o.category,
    status: 'live',
    planCode: key === 'cafe' ? 'pro' : 'start',
    branding: { primaryColor: stamps ? '#1F2937' : '#6B3E26', poweredBy: true },
  });
  await tx
    .insert(s.branches)
    .values({ id: o.branchId, organizationId: o.id, name: 'Sede principal', address: 'Lima, Perú' });

  const staffPin = await argon2Hash(SEED.pins.staff);
  const ownerPin = await argon2Hash(SEED.pins.owner);
  const team: (typeof s.organizationUsers.$inferInsert)[] = [
    {
      id: o.owner.orgUserId,
      organizationId: o.id,
      userId: o.owner.id,
      displayName: o.owner.name,
      role: 'owner',
      pinHash: ownerPin,
    },
    ...o.staff.map((st) => ({
      id: st.orgUserId,
      organizationId: o.id,
      displayName: st.name,
      role: 'staff' as const,
      pinHash: staffPin,
    })),
  ];
  if (o.admin)
    team.push({
      id: o.admin.orgUserId,
      organizationId: o.id,
      userId: o.admin.id,
      displayName: o.admin.name,
      role: 'admin',
      pinHash: ownerPin,
    });
  await tx.insert(s.organizationUsers).values(team);

  await tx.insert(s.loyaltyPrograms).values({
    id: o.programId,
    organizationId: o.id,
    name: `Club ${o.name}`,
    mode: stamps ? 'stamps' : 'points',
    unitLabel: stamps ? 'sellos' : 'puntos',
    status: 'active',
  });
  await tx.insert(s.programRuleVersions).values({
    id: o.ruleVersionId,
    organizationId: o.id,
    programId: o.programId,
    version: 1,
    earnRule: stamps
      ? { type: 'per_visit', units: 1 }
      : { type: 'per_amount', amount_per_unit: 1, rounding: 'floor' },
    goal: stamps ? goal : null,
    limits: stamps
      ? { cooldown_minutes: 240, max_units_per_tx: 1, staff_daily_units: 200 }
      : { max_amount_per_tx: 500, staff_daily_units: 5000 },
    createdBy: o.owner.orgUserId,
  });
  await tx
    .update(s.loyaltyPrograms)
    .set({ currentVersionId: o.ruleVersionId })
    .where(sql`id = ${o.programId}`);

  const catalog: { id: string; name: string; cost: number }[] = [];
  if (stamps) {
    await tx.insert(s.rewards).values({
      id: o.rewardId,
      organizationId: o.id,
      programId: o.programId,
      kind: 'goal',
      name: key === 'barberia' ? 'Corte gratis' : 'Baño gratis',
      validityDays: 90,
    });
  } else {
    const items = [
      { name: 'Café americano', cost: 50 },
      { name: 'Capuccino', cost: 80 },
      { name: 'Postre de la casa', cost: 120 },
    ];
    for (const [i, it] of items.entries()) {
      const id = i === 0 ? o.rewardId : undefined;
      const [r] = await tx
        .insert(s.rewards)
        .values({
          id,
          organizationId: o.id,
          programId: o.programId,
          kind: 'catalog',
          name: it.name,
          cost: it.cost,
          sortOrder: i,
        })
        .returning({ id: s.rewards.id });
      catalog.push({ id: r!.id, ...it });
    }
  }

  await tx.insert(s.shortLinks).values({
    slug: o.linkSlug,
    organizationId: o.id,
    branchId: o.branchId,
    kind: 'registration',
    target: `/join/${o.linkSlug}`,
  });

  const consents = await tx
    .select({ id: s.consentVersions.id, kind: s.consentVersions.kind })
    .from(s.consentVersions);
  const now = Date.now();
  const DAY = 86_400_000;
  let entries = 0;
  let earned = 0;
  let redeemed = 0;

  for (let i = 1; i <= o.customers; i++) {
    const customerId = seedCustomerId(key, i);
    const membershipId = seedMembershipId(key, i);
    const phone =
      i === 1 && key !== 'cafe'
        ? SEED.sharedPhone
        : `+519${(key === 'barberia' ? 71 : key === 'cafe' ? 72 : 73).toString()}${String(100000 + i).slice(-6)}`;
    const name = `${FIRST[Math.floor(rand() * FIRST.length)]} ${LAST[Math.floor(rand() * LAST.length)]}`;
    const createdAt = new Date(now - (60 + Math.floor(rand() * 60)) * DAY);

    await tx
      .insert(s.customers)
      .values({ id: customerId, organizationId: o.id, fullName: name, phoneE164: phone, createdAt });
    await tx.insert(s.customerConsents).values(
      consents
        .filter((c) => c.kind !== 'marketing' || rand() < 0.6)
        .map((c) => ({
          organizationId: o.id,
          customerId,
          consentVersionId: c.id,
          granted: true,
          channel: rand() < 0.7 ? ('qr' as const) : ('nfc' as const),
          createdAt,
        })),
    );

    // Historial simulado siguiendo las mismas reglas que implementará el motor (semana 2).
    const visits = Math.floor(rand() * (stamps ? 24 : 14));
    let balance = 0;
    let lifetime = 0;
    let seq = 0;
    let t = createdAt.getTime();
    let firstValidatedAt: Date | null = null;
    const rows: (typeof s.ledgerEntries.$inferInsert)[] = [];
    const earnedRows: (typeof s.earnedRewards.$inferInsert)[] = [];
    const redemptionRows: (typeof s.redemptions.$inferInsert)[] = [];
    const staffId = o.staff[Math.floor(rand() * o.staff.length)]!.orgUserId;
    const entry = (
      kind: (typeof s.ledgerKind.enumValues)[number],
      delta: number,
      extra: Partial<typeof s.ledgerEntries.$inferInsert> = {},
    ) => {
      balance += delta;
      if (delta > 0 && kind === 'earn') lifetime += delta;
      const id = randomUUID();
      seq++;
      rows.push({
        id,
        organizationId: o.id,
        membershipId,
        branchId: o.branchId,
        kind,
        delta,
        ruleVersionId: o.ruleVersionId,
        actorType: 'staff',
        actorId: staffId,
        idempotencyKey: `seed:${membershipId}:${seq}`,
        balanceAfter: balance,
        createdAt: new Date(t),
        ...extra,
      });
      return id;
    };

    for (let v = 0; v < visits; v++) {
      t += Math.floor((1 + rand() * 4) * DAY);
      if (t > now) break;
      firstValidatedAt ??= new Date(t);
      if (stamps) {
        const earnId = entry('earn', 1);
        if (balance >= goal) {
          const convertId = entry('convert', -goal, {
            actorType: 'system',
            actorId: null,
            causedByEntryId: earnId,
          });
          const earnedId = randomUUID();
          const willRedeem = rand() < 0.6;
          earnedRows.push({
            id: earnedId,
            organizationId: o.id,
            membershipId,
            rewardId: o.rewardId,
            source: 'goal',
            sourceEntryId: convertId,
            status: willRedeem ? 'redeemed' : 'available',
            expiresAt: new Date(t + 90 * DAY),
            createdAt: new Date(t),
            redeemedAt: willRedeem ? new Date(t + DAY) : null,
          });
          if (willRedeem)
            redemptionRows.push({
              organizationId: o.id,
              membershipId,
              rewardId: o.rewardId,
              earnedRewardId: earnedId,
              branchId: o.branchId,
              organizationUserId: staffId,
              idempotencyKey: `seed:redeem:${earnedId}`,
              createdAt: new Date(t + DAY),
            });
        }
      } else {
        const amount = 8 + Math.floor(rand() * 40);
        entry('earn', amount, { amountMoney: amount.toFixed(2) });
        const affordable = catalog.filter((c) => c.cost <= balance);
        if (affordable.length && rand() < 0.3) {
          const reward = affordable[Math.floor(rand() * affordable.length)]!;
          const redeemId = entry('redeem', -reward.cost);
          redemptionRows.push({
            organizationId: o.id,
            membershipId,
            rewardId: reward.id,
            ledgerEntryId: redeemId,
            branchId: o.branchId,
            organizationUserId: staffId,
            idempotencyKey: `seed:redeem:${redeemId}`,
            createdAt: new Date(t),
          });
        }
      }
    }

    await tx.insert(s.memberships).values({
      id: membershipId,
      organizationId: o.id,
      programId: o.programId,
      customerId,
      memberScanToken: newToken(),
      // Los clientes del seed no tienen la URL de su tarjeta: solo se guarda el hash de un token descartado.
      webCardTokenHash: createHash('sha256').update(newToken()).digest('hex'),
      shortCode: shortCode(rand),
      balance,
      lifetimeEarned: lifetime,
      firstValidatedAt,
      lastActivityAt: rows.length ? rows[rows.length - 1]!.createdAt! : null,
      createdAt,
    });
    if (rows.length) await tx.insert(s.ledgerEntries).values(rows);
    if (earnedRows.length) await tx.insert(s.earnedRewards).values(earnedRows);
    if (redemptionRows.length) await tx.insert(s.redemptions).values(redemptionRows);
    entries += rows.length;
    earned += earnedRows.length;
    redeemed += redemptionRows.length;

    // Pases simulados para las 3 primeras membresías: sirven para probar el Wallet simulado.
    if (i <= 3) {
      await tx.insert(s.walletPasses).values([
        {
          organizationId: o.id,
          membershipId,
          provider: 'google',
          issuerRef: 'fake:google-local',
          externalId: `fake.${membershipId}`,
        },
        ...(i <= 2
          ? [
              {
                organizationId: o.id,
                membershipId,
                provider: 'apple' as const,
                issuerRef: 'fake:apple-local',
                externalId: `fake-${membershipId}`,
              },
            ]
          : []),
      ]);
    }
  }

  return { customers: o.customers, entries, earned, redeemed };
}
