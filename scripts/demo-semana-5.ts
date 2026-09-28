/**
 * Demo de la semana 5: panel del dueño en celulares emulados (Android e iPhone).
 * Un negocio nuevo de cero a su primera tarjeta sin tocar código: alta desde el panel maestro →
 * invitación por correo → marca con logo → programa → sucursales → trabajador por sucursal →
 * publicación → caja autorizada → primer cliente → gestión del cliente. Incluye las suites anteriores
 * (cliente y caja) para comprobar que nada se rompió.
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

console.log(bold('\nAiment Wallet · Demo semana 5 · Panel del dueño de principio a fin\n'));
let stop: (() => void) | null = null;
if (!(await isUp(`${base}/health`))) {
  console.log('Levantando API y PWA…');
  stop = startServices();
  await waitUp(`${base}/health`);
}

const authUp = await isUp(`${process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'}/auth/v1/health`);
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
const shots = existsSync(dir)
  ? readdirSync(dir).filter((f) => f.includes('-panel-') && f.endsWith('.png'))
  : [];
console.log(bold(`\nCapturas del panel (${shots.length}) en e2e/artifacts/`));
for (const s of shots.sort()) console.log(`  · ${s}`);
for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith('-panel-tiempo.json')) : []) {
  const t = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { configuracionHastaPrimeraTarjetaMs: number };
  console.log(
    `  · ${f.split('-')[0]}: configuración hasta la primera tarjeta en ${(t.configuracionHastaPrimeraTarjetaMs / 1000).toFixed(0)} s (meta: < 15 min)`,
  );
}
const pw = process.env.SEED_USER_PASSWORD ?? 'aiment-demo-2026';
console.log(bold('\nPruébalo tú en el navegador (con `pnpm dev` corriendo):'));
console.log(`  Panel maestro (crear negocio): ${base}/admin   (superadmin@aiment.test / ${pw})`);
console.log(`  Invitación al dueño:           llega a Mailpit http://127.0.0.1:54324`);
console.log(`  Panel del dueño:               ${base}/panel   (dueno.barberia@aiment.test / ${pw})`);
console.log(`  Límites del plan Start:        ${base}/panel   (dueno.vet@aiment.test / ${pw})`);
console.log(
  `  Caja:                          ${base}/caja    (autorízala en Panel → Cajas; PIN caja 2580, dueño 1470)`,
);
console.log('  En tu celular:                 pnpm local:tunnel\n');
process.exit(result.status ?? 1);
