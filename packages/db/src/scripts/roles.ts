import { ensureAppRole } from '../admin';
import { env } from './env';

await ensureAppRole(env.DATABASE_ADMIN_URL, env.APP_DB_USER, env.APP_DB_PASSWORD);
console.log(`✔ Rol de la API "${env.APP_DB_USER}" listo (miembro de app_api, sin BYPASSRLS)`);
