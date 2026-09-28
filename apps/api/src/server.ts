import { serve } from '@hono/node-server';
import { apiEnvSchema, parseEnv } from '@aiment/config';
import { createDb } from '@aiment/db';
import { createApp } from './app';
import { createSupabaseVerifier } from './auth/verifier';

const env = parseEnv(apiEnvSchema);
const { db, close } = createDb(env.DATABASE_URL);
const app = createApp({
  db,
  verifier: createSupabaseVerifier({ supabaseUrl: env.SUPABASE_URL, jwtSecret: env.SUPABASE_JWT_SECRET }),
  config: { requireSuperadminMfa: env.AUTH_REQUIRE_SUPERADMIN_MFA },
});

const server = serve({ fetch: app.fetch, port: env.API_PORT }, (info) =>
  console.log(`✔ API de Aiment Wallet en http://localhost:${info.port}`),
);

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    server.close();
    void close().finally(() => process.exit(0));
  });
