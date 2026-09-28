/**
 * Prueba de Google Wallet en modo demo (semana 1).
 * Genera un enlace "Guardar en Google Wallet" con un pase ficticio de la Barbería Pedro.
 * Guía paso a paso: docs/guia-google-wallet-demo.md
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { loadRootEnv, repoRoot } from '@aiment/config';
import { buildGoogleSaveUrl, type GoogleServiceAccount } from '../google/save-link';

loadRootEnv();
const issuerId = process.env.GOOGLE_WALLET_ISSUER_ID?.trim();
const saPath = process.env.GOOGLE_WALLET_SA_JSON_PATH?.trim() || './secrets/google-wallet-sa.json';
const logoUrl = process.env.GOOGLE_DEMO_LOGO_URL?.trim();
const fullSaPath = isAbsolute(saPath) ? saPath : join(repoRoot, saPath);

const missing = [
  !issuerId && 'GOOGLE_WALLET_ISSUER_ID (ID del emisor en la consola Google Pay & Wallet)',
  !existsSync(fullSaPath) && `archivo de la cuenta de servicio en ${saPath}`,
  !logoUrl?.startsWith('https://') && 'GOOGLE_DEMO_LOGO_URL (logo PNG/JPG en una URL pública https)',
].filter(Boolean);

if (missing.length) {
  console.error('✖ Faltan datos para la prueba de Google Wallet:');
  for (const m of missing) console.error(`  - ${m}`);
  console.error('\nSigue docs/guia-google-wallet-demo.md y vuelve a ejecutar: pnpm wallet:google-demo');
  process.exit(1);
}

const sa = JSON.parse(readFileSync(fullSaPath, 'utf8')) as GoogleServiceAccount;
const runId = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const { url, classId, objectId } = await buildGoogleSaveUrl({
  issuerId: issuerId!,
  serviceAccount: sa,
  logoUrl: logoUrl!,
  classSuffix: 'aw_demo_barberia_pedro',
  objectSuffix: `aw_demo_${runId}`,
  view: {
    membershipId: `demo-${runId}`,
    organizationId: 'demo',
    organizationName: 'Barbería Pedro (demo)',
    programName: 'Club Barbería Pedro',
    mode: 'stamps',
    unitLabel: 'sellos',
    balance: 7,
    goal: 10,
    availableRewards: 0,
    customerDisplayName: 'Cliente de prueba',
    scanUrl: 'https://example.com/s/demo-token-no-real',
    shortCode: 'DEMO01',
    primaryColor: '#1F2937',
  },
});

console.log('✔ Pase de demo generado');
console.log(`  Clase:  ${classId}`);
console.log(`  Objeto: ${objectId}`);
console.log('\nAbre este enlace en un Android con la cuenta de Google agregada como usuario de prueba:\n');
console.log(url);
console.log('\n(En modo demo el pase muestra una marca de "prueba". Es lo esperado.)');
