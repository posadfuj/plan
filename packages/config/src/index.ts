import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Raíz del monorepo (donde vive pnpm-workspace.yaml). */
export const repoRoot = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, 'pnpm-workspace.yaml'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error('No se encontró la raíz del monorepo');
    dir = parent;
  }
  return dir;
})();

let loaded = false;

/** Carga el .env de la raíz si existe. Las variables ya definidas en el entorno tienen prioridad. */
export function loadRootEnv(): void {
  if (loaded) return;
  loaded = true;
  const file = join(repoRoot, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

export const dbEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  DATABASE_ADMIN_URL: z.string().url(),
  APP_DB_USER: z.string().default('aiment_api'),
  APP_DB_PASSWORD: z.string().min(8),
});

export const authEnvSchema = z.object({
  SUPABASE_URL: z.string().url(),
  /** Solo entornos con JWT HS256 (Supabase local / legacy). En producción se usa JWKS. */
  SUPABASE_JWT_SECRET: z.string().optional(),
  AUTH_REQUIRE_SUPERADMIN_MFA: bool,
});

export const apiEnvSchema = dbEnvSchema.extend(authEnvSchema.shape).extend({
  API_PORT: z.coerce.number().int().default(8787),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:5173'),
  /** true solo detrás de un proxy o túnel de confianza (Vite dev, Cloudflare). */
  TRUST_PROXY: bool,
  VISITOR_HASH_SALT: z.string().min(16).optional(),
  /** Cookies de caja con Secure. Vacío = automático (true si PUBLIC_BASE_URL es https). */
  SECURE_COOKIES: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  /** Límites por IP (ver apps/api/src/rate-limit.ts). Vacíos = valores de producción. */
  RATE_LIMIT_REGISTER: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_RECOVERY: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_REDEEM: z.coerce.number().int().positive().optional(),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;

export function parseEnv<T extends z.ZodTypeAny>(
  schema: T,
  source: NodeJS.ProcessEnv = process.env,
): z.infer<T> {
  loadRootEnv();
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Variables de entorno inválidas:\n${issues}\n(Revisa .env / .env.example)`);
  }
  return result.data;
}
