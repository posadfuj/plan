import { runMigrations } from '../admin';
import { env } from './env';

await runMigrations(env.DATABASE_ADMIN_URL);
console.log('✔ Migraciones aplicadas');
