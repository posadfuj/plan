import { serve } from '@hono/node-server';
import { apiEnvSchema, parseEnv } from '@aiment/config';
import { createDb } from '@aiment/db';
import { createMailerFromEnv } from '@aiment/mail';
import { randomBytes } from 'node:crypto';
import { createApp } from './app';
import { createSupabaseVerifier } from './auth/verifier';

const env = parseEnv(apiEnvSchema);
const { db, close } = createDb(env.DATABASE_URL);
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
    },
  },
  mailer: createMailerFromEnv(),
});

const server = serve({ fetch: app.fetch, port: env.API_PORT }, (info) =>
  console.log(`✔ API de Aiment Wallet en http://localhost:${info.port}`),
);

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    server.close();
    void close().finally(() => process.exit(0));
  });
