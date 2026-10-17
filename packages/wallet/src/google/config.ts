/**
 * Arma el proveedor de Google Wallet desde la configuración. La API y el worker usan esta misma
 * función, así nunca quedan en modos distintos.
 *
 *   GOOGLE_WALLET_MODE=auto (por defecto) → real si están el Issuer ID, la cuenta de servicio y
 *                                            PUBLIC_BASE_URL es https; si falta algo, simulado.
 *   GOOGLE_WALLET_MODE=live              → real; si falta algo, no arranca (error claro).
 *   GOOGLE_WALLET_MODE=simulated         → simulado aunque haya credenciales.
 *   GOOGLE_WALLET_MODE=off               → sin Google Wallet (el botón no aparece).
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { repoRoot, type WalletEnv } from '@aiment/config';
import { exportPKCS8, generateKeyPair } from 'jose';
import { HttpGoogleWalletApi, type GoogleWalletApi } from './api';
import { GoogleWalletProvider } from './provider';
import type { GoogleServiceAccount } from './save-link';
import { SimulatedGoogleWalletApi } from './simulated';

/** Issuer ID ficticio del modo simulado (los ids reales también empiezan con 3388). */
export const SIMULATED_ISSUER_ID = '3388000000000000000';

export interface GoogleWalletSetup {
  provider: GoogleWalletProvider | null;
  /** Una línea para el log de arranque (sin secretos). */
  summary: string;
}

export async function createGoogleWallet(
  env: WalletEnv,
  publicBaseUrl: string,
  opts: { log?: (msg: string) => void; api?: GoogleWalletApi } = {},
): Promise<GoogleWalletSetup> {
  if (env.GOOGLE_WALLET_MODE === 'off') return { provider: null, summary: 'Google Wallet desactivado' };

  const problems: string[] = [];
  const saPath = isAbsolute(env.GOOGLE_WALLET_SA_JSON_PATH)
    ? env.GOOGLE_WALLET_SA_JSON_PATH
    : join(repoRoot, env.GOOGLE_WALLET_SA_JSON_PATH);
  if (!env.GOOGLE_WALLET_ISSUER_ID) problems.push('falta GOOGLE_WALLET_ISSUER_ID');
  else if (!/^\d{10,25}$/.test(env.GOOGLE_WALLET_ISSUER_ID))
    problems.push('GOOGLE_WALLET_ISSUER_ID debe ser el número largo de la consola de Google Pay & Wallet');
  const serviceAccount = readServiceAccount(saPath, env.GOOGLE_WALLET_SA_JSON_PATH, problems);
  if (!publicBaseUrl.startsWith('https://'))
    problems.push('PUBLIC_BASE_URL debe ser https (Google descarga el logo desde ahí): usa el túnel');

  const wantsLive = env.GOOGLE_WALLET_MODE === 'live';
  if (wantsLive && problems.length)
    throw new Error(`GOOGLE_WALLET_MODE=live, pero:\n  - ${problems.join('\n  - ')}`);

  if (env.GOOGLE_WALLET_MODE !== 'simulated' && !problems.length) {
    const issuerId = env.GOOGLE_WALLET_ISSUER_ID!;
    return {
      provider: new GoogleWalletProvider({
        mode: 'live',
        issuerId,
        serviceAccount: serviceAccount!,
        api: opts.api ?? new HttpGoogleWalletApi({ serviceAccount: serviceAccount! }),
        publicBaseUrl,
      }),
      summary: `Google Wallet REAL (emisor …${issuerId.slice(-4)}, ${serviceAccount!.client_email})`,
    };
  }

  // Simulado: clave RSA de usar y tirar; el JWT se firma igual que en real, pero nadie lo verifica.
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const why = env.GOOGLE_WALLET_MODE === 'simulated' ? 'GOOGLE_WALLET_MODE=simulated' : problems.join('; ');
  return {
    provider: new GoogleWalletProvider({
      mode: 'simulated',
      issuerId: SIMULATED_ISSUER_ID,
      serviceAccount: {
        client_email: 'simulado@aiment-wallet.local',
        private_key: await exportPKCS8(privateKey),
      },
      api: opts.api ?? new SimulatedGoogleWalletApi(opts.log ? { log: opts.log } : {}),
      publicBaseUrl,
    }),
    summary: `Google Wallet SIMULADO (${why})`,
  };
}

function readServiceAccount(path: string, shown: string, problems: string[]): GoogleServiceAccount | null {
  if (!existsSync(path)) {
    problems.push(`no está el archivo de la cuenta de servicio (${shown})`);
    return null;
  }
  try {
    const sa = JSON.parse(readFileSync(path, 'utf8')) as Partial<GoogleServiceAccount>;
    if (typeof sa.client_email === 'string' && sa.private_key?.includes('PRIVATE KEY'))
      return { client_email: sa.client_email, private_key: sa.private_key };
  } catch {
    // cae al mensaje de abajo
  }
  problems.push(`${shown} no es el JSON de una cuenta de servicio (faltan client_email / private_key)`);
  return null;
}
