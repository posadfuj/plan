import { serve } from '@hono/node-server';
import { apiEnvSchema, parseEnv, repoRoot } from '@aiment/config';
import { createDb } from '@aiment/db';
import { createMailerFromEnv } from '@aiment/mail';
import { LocalDiskStorage, S3Storage, type ObjectStorage } from '@aiment/storage';
import { Alerter, LatencyWindow } from '@aiment/ops';
import { createGoogleWallet } from '@aiment/wallet';
import { randomBytes } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { createApp } from './app';
import { createSupabaseAuthAdmin } from './auth/admin';
import { createSupabaseVerifier } from './auth/verifier';

const env = parseEnv(apiEnvSchema);
const { db, close } = createDb(env.DATABASE_URL);
const google = await createGoogleWallet(env, env.PUBLIC_BASE_URL);
const mailer = createMailerFromEnv();

// Monitoreo de la caja: p95 y errores de los últimos 15 minutos, revisados cada minuto.
const cashier = new LatencyWindow(15);
const alerter = new Alerter({
  source: 'api',
  webhookUrl: env.ALERT_WEBHOOK_URL,
  email: env.ALERT_EMAIL ? { mailer, to: env.ALERT_EMAIL } : undefined,
  log: (m) => console.log(m),
});
const monitor = setInterval(() => {
  const s = cashier.stats();
  if (s.count >= 20 && s.p95 !== null && s.p95 > 1500)
    void alerter.notify({
      key: 'caja-lenta',
      level: 'warning',
      message: `La caja responde lento: p95 de ${Math.round(s.p95)} ms en ${s.count} operaciones (últimos 15 min).`,
    });
  else alerter.clear('caja-lenta');
  if (s.errors >= 10)
    void alerter.notify({
      key: 'caja-errores',
      level: 'critical',
      message: `${s.errors} errores del servidor en la caja en los últimos 15 minutos.`,
    });
  else alerter.clear('caja-errores');
}, 60_000);
monitor.unref();

function createStorage(): ObjectStorage {
  if (env.STORAGE_DRIVER === 'local')
    return new LocalDiskStorage(
      isAbsolute(env.STORAGE_DIR) ? env.STORAGE_DIR : join(repoRoot, env.STORAGE_DIR),
    );
  const missing = (
    ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'] as const
  ).filter((k) => !env[k]);
  if (missing.length) throw new Error(`STORAGE_DRIVER=r2, pero faltan: ${missing.join(', ')}`);
  return new S3Storage({
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    bucket: env.R2_BUCKET!,
    accessKeyId: env.R2_ACCESS_KEY_ID!,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
  });
}
const app = createApp({
  db,
  verifier: createSupabaseVerifier({ supabaseUrl: env.SUPABASE_URL, jwtSecret: env.SUPABASE_JWT_SECRET }),
  config: {
    requireSuperadminMfa: env.AUTH_REQUIRE_SUPERADMIN_MFA,
    publicBaseUrl: env.PUBLIC_BASE_URL,
    trustProxy: env.TRUST_PROXY,
    visitorSalt: env.VISITOR_HASH_SALT ?? randomBytes(16).toString('hex'),
    ...(env.SECURE_COOKIES !== undefined ? { secureCookies: env.SECURE_COOKIES } : {}),
    rateLimits: {
      ...(env.RATE_LIMIT_REGISTER ? { register: env.RATE_LIMIT_REGISTER } : {}),
      ...(env.RATE_LIMIT_RECOVERY ? { recovery: env.RATE_LIMIT_RECOVERY } : {}),
      ...(env.RATE_LIMIT_REDEEM ? { redeem: env.RATE_LIMIT_REDEEM } : {}),
      ...(env.RATE_LIMIT_DEVICE_PAIR ? { devicePair: env.RATE_LIMIT_DEVICE_PAIR } : {}),
    },
  },
  mailer,
  onCashierRequest: (ms, status) => cashier.record(ms, status),
  storage: createStorage(),
  authAdmin: env.SUPABASE_SECRET_KEY
    ? createSupabaseAuthAdmin({ supabaseUrl: env.SUPABASE_URL, secretKey: env.SUPABASE_SECRET_KEY })
    : null,
  googleWallet: google.provider,
});

const server = serve({ fetch: app.fetch, port: env.API_PORT }, (info) =>
  console.log(
    `✔ API de Aiment Wallet en http://localhost:${info.port} · ${google.summary} · archivos: ${env.STORAGE_DRIVER} · correo: ${process.env.MAIL_TRANSPORT ?? 'smtp'}`,
  ),
);

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    server.close();
    void close().finally(() => process.exit(0));
  });
