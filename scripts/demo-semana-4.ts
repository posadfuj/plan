/**
 * Demo de la semana 4: caja en celulares emulados (Android e iPhone), más el flujo del cliente.
 * Dispositivo autorizado por QR → turno con PIN → ESCANEAR CLIENTE con la cámara (simulada, lee el
 * QR de la tarjeta) → sumar → excepción con PIN del dueño → anular → buscar → recuperación en caja.
 * Mide cada operación con la CPU 4× más lenta y red móvil (Android de gama media).
 *
 * Requisitos: `pnpm local:setup` y Chromium de Playwright (`pnpm exec playwright install chromium`).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadRootEnv, repoRoot } from '@aiment/config';
import { isUp, startServices, waitUp } from './services';

loadRootEnv();
const base = 'http://localhost:5173';
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

console.log(bold('\nAiment Wallet · Demo semana 4 · Caja con PIN y dispositivo autorizado\n'));
let stop: (() => void) | null = null;
if (!(await isUp(`${base}/health`))) {
  console.log('Levantando API y PWA…');
  stop = startServices();
  await waitUp(`${base}/health`);
}

const authUp = await isUp(`${process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'}/auth/v1/health`);
// Entorno en la nube con Chromium preinstalado; en tu computadora Playwright usa el suyo.
const preinstalled = existsSync('/opt/pw-browsers')
  ? readdirSync('/opt/pw-browsers')
      .filter((d) => /^chromium-\d+$/.test(d))
      .map((d) => `/opt/pw-browsers/${d}/chrome-linux/chrome`)
      .find((p) => existsSync(p))
  : undefined;
const chromium = process.env.PW_CHROMIUM_PATH ?? preinstalled ?? '';
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
for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith('-caja-tiempos.json')) : []) {
  const t = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, number>;
  console.log(bold(`\nTiempos de caja (${f.split('-')[0]}, CPU 4× más lenta y red móvil):`));
  for (const [op, ms] of Object.entries(t)) console.log(`  · ${op}: ${(ms / 1000).toFixed(1)} s`);
}
console.log(bold('\nPruébalo tú en el navegador (con `pnpm dev` corriendo):'));
console.log(`  Cliente (QR del local):  ${base}/go/BRB2K?c=q`);
console.log(
  `  Panel del dueño:         ${base}/panel   (dueno.barberia@aiment.test / ${process.env.SEED_USER_PASSWORD ?? 'aiment-demo-2026'})`,
);
console.log(
  `  Caja:                    ${base}/caja   (autorízala desde el panel → Caja; PIN caja 2580, dueño 1470)`,
);
console.log(`  Correos de recuperación: http://127.0.0.1:54324 (Mailpit)`);
console.log('  En tu celular:           pnpm local:tunnel\n');
process.exit(result.status ?? 1);
