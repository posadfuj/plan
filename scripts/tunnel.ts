/**
 * Túnel HTTPS para probar en celulares reales (cámara, NFC, pantallas reales).
 * Levanta API + PWA con PUBLIC_BASE_URL = URL del túnel y muestra un QR en la terminal.
 * Usa un túnel rápido de Cloudflare (gratis, URL temporal). Ctrl+C para cerrar todo.
 *
 * Detén antes `pnpm dev` si está corriendo (usa los mismos puertos).
 */
import { spawn } from 'node:child_process';
import QRCode from 'qrcode';
import { loadRootEnv } from '@aiment/config';
import { isUp, startServices, waitUp } from './services';

loadRootEnv();
if (await isUp('http://localhost:8787/health')) {
  console.error('✖ La API ya está corriendo (¿pnpm dev?). Detenla y vuelve a ejecutar pnpm local:tunnel.');
  process.exit(1);
}

console.log('Abriendo túnel HTTPS (Cloudflare)…');
const cf = spawn(
  'npx',
  ['--yes', 'cloudflared', 'tunnel', '--url', 'http://localhost:5173', '--no-autoupdate'],
  {
    shell: process.platform === 'win32',
  },
);
const url = await new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('El túnel no respondió en 60 s')), 60_000);
  const onData = (buf: Buffer) => {
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(buf.toString());
    if (m) {
      clearTimeout(timer);
      resolve(m[0]);
    }
  };
  cf.stdout.on('data', onData);
  cf.stderr.on('data', onData);
  cf.on('exit', (code) => reject(new Error(`cloudflared terminó (código ${code})`)));
});

const stop = startServices({ PUBLIC_BASE_URL: url, TRUST_PROXY: 'true' });
await waitUp('http://localhost:5173/health');
const cleanup = () => {
  stop();
  cf.kill();
  process.exit(0);
};
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

const joinUrl = `${url}/go/BRB2K?c=q`;
console.log(`\n✔ Túnel listo: ${url}\n`);
console.log('Escanea con tu celular para registrarte en la Barbería Pedro (datos de prueba):\n');
console.log(await QRCode.toString(joinUrl, { type: 'terminal', small: true }));
console.log(`  Registro:  ${joinUrl}`);
console.log(`  NFC:       ${url}/go/BRB2K?c=n   (grábalo en un tag solo para pruebas)`);
console.log(`  Panel:     ${url}/panel`);
console.log('\nChecklist: docs/prueba-celulares.md · Ctrl+C para cerrar el túnel.');
