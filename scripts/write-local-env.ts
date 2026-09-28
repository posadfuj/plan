/**
 * Genera .env para desarrollo local a partir de `supabase status` (Supabase CLI en Docker).
 * Conserva las variables ya definidas en .env que no vienen de Supabase.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '@aiment/config';

const status = JSON.parse(
  execFileSync('pnpm', ['exec', 'supabase', 'status', '-o', 'json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32', // en Windows pnpm es pnpm.cmd
  }),
) as Record<string, string>;

const envPath = join(repoRoot, '.env');
const example = readFileSync(join(repoRoot, '.env.example'), 'utf8');
const current = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
const parse = (text: string) =>
  Object.fromEntries(
    text
      .split('\n')
      .filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
const prev = parse(current);

const appPassword =
  prev.APP_DB_PASSWORD && prev.APP_DB_PASSWORD !== 'cambia-esta-clave-local'
    ? prev.APP_DB_PASSWORD
    : randomBytes(18).toString('base64url');
const db = new URL(status.DB_URL!);
const apiUrl = new URL(db);
apiUrl.username = prev.APP_DB_USER ?? 'aiment_api';
apiUrl.password = appPassword;

const values: Record<string, string> = {
  ...parse(example),
  ...prev,
  DATABASE_ADMIN_URL: status.DB_URL!,
  APP_DB_PASSWORD: appPassword,
  DATABASE_URL: apiUrl.toString(),
  SUPABASE_URL: status.API_URL!,
  SUPABASE_PUBLISHABLE_KEY: status.PUBLISHABLE_KEY ?? status.ANON_KEY!,
  SUPABASE_SECRET_KEY: status.SECRET_KEY ?? status.SERVICE_ROLE_KEY!,
  SUPABASE_JWT_SECRET: status.JWT_SECRET!,
  VISITOR_HASH_SALT: prev.VISITOR_HASH_SALT || randomBytes(16).toString('hex'),
};

const out = example
  .split('\n')
  .map((l) => {
    const m = /^([A-Z0-9_]+)=/.exec(l);
    return m ? `${m[1]}=${values[m[1]!] ?? ''}` : l;
  })
  .join('\n');
writeFileSync(envPath, out, { mode: 0o600 });
console.log(
  `✔ .env generado (${Object.keys(values).length} variables). Supabase Auth: ${status.API_URL} · Mailpit: ${status.MAILPIT_URL ?? status.INBUCKET_URL}`,
);
