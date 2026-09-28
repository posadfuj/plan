/**
 * Demo de la semana 3: flujo completo del cliente en celulares emulados (Android e iPhone).
 * QR/NFC del local → landing → registro → tarjeta web → QR individual (verificado desde la pantalla),
 * duplicado sin segunda membresía, recuperación por correo y en el local.
 *
 * Requisitos: `pnpm local:setup` y Chromium de Playwright (`pnpm exec playwright install chromium`).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadRootEnv, repoRoot } from '@aiment/config';
import { isUp, startServices, waitUp } from './services';

loadRootEnv();
const base = 'http://localhost:5173';
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

console.log(bold('\nAiment Wallet · Demo semana 3 · Flujo completo del cliente\n'));
let stop: (() => void) | null = null;
if (!(await isUp(`${base}/health`))) {
  console.log('Levantando API y PWA…');
  stop = startServices();
  await waitUp(`${base}/health`);
}

const authUp = await isUp(`${process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'}/auth/v1/health`);
const chromium =
  process.env.PW_CHROMIUM_PATH ??
  (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : '');
const result = spawnSync('pnpm', ['exec', 'playwright', 'test', '-c', 'e2e/playwright.config.ts'], {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    E2E_BASE_URL: base,
    ...(authUp ? { E2E_AUTH: '1' } : {}),
    ...(chromium ? { PW_CHROMIUM_PATH: chromium } : {}),
  },
});
stop?.();

const dir = join(repoRoot, 'e2e', 'artifacts');
const shots = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.png')) : [];
console.log(bold(`\nCapturas (${shots.length}) en e2e/artifacts/`));
for (const s of shots.sort()) console.log(`  · ${s}`);
console.log(bold('\nPruébalo tú en el navegador (con `pnpm dev` corriendo):'));
console.log(`  Cliente (QR del local):  ${base}/go/BRB2K?c=q`);
console.log(
  `  Panel del dueño:         ${base}/panel   (dueno.barberia@aiment.test / ${process.env.SEED_USER_PASSWORD ?? 'aiment-demo-2026'})`,
);
console.log(`  Correos de recuperación: http://127.0.0.1:54324 (Mailpit)`);
console.log('  En tu celular:           pnpm local:tunnel\n');
process.exit(result.status ?? 1);
