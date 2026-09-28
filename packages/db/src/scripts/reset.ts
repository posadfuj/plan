import { ensureAppRole, resetDatabase, runMigrations, seedDatabase } from '../admin';
import { env } from './env';

const url = new URL(env.DATABASE_ADMIN_URL);
if (!['127.0.0.1', 'localhost'].includes(url.hostname) && process.env.ALLOW_REMOTE_RESET !== 'true') {
  console.error(`✖ db:reset solo se permite contra una base local (host actual: ${url.hostname}).`);
  process.exit(1);
}

await resetDatabase(env.DATABASE_ADMIN_URL);
console.log('✔ Base local vaciada');
await runMigrations(env.DATABASE_ADMIN_URL);
console.log('✔ Migraciones aplicadas');
await ensureAppRole(env.DATABASE_ADMIN_URL, env.APP_DB_USER, env.APP_DB_PASSWORD);
console.log(`✔ Rol "${env.APP_DB_USER}" listo`);
await seedDatabase(env.DATABASE_ADMIN_URL, {
  auth:
    env.SUPABASE_URL && env.SUPABASE_SECRET_KEY
      ? {
          supabaseUrl: env.SUPABASE_URL,
          secretKey: env.SUPABASE_SECRET_KEY,
          password: env.SEED_USER_PASSWORD,
        }
      : undefined,
  log: (m) => console.log(`  ${m}`),
});
console.log('✔ Datos de prueba cargados');
