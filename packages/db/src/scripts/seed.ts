import { seedDatabase } from '../admin';
import { env } from './env';

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
