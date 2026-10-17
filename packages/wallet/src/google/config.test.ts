import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportPKCS8, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { createGoogleWallet, SIMULATED_ISSUER_ID } from './config';

const ISSUER = '3388000000012345678';
let saPath: string;
let badPath: string;
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aiment-gw-'));
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  saPath = join(dir, 'sa.json');
  writeFileSync(
    saPath,
    JSON.stringify({
      client_email: 'w@p.iam.gserviceaccount.com',
      private_key: await exportPKCS8(privateKey),
    }),
  );
  badPath = join(dir, 'bad.json');
  writeFileSync(badPath, '{"type":"otra cosa"}');
});

const env = (o: Partial<Parameters<typeof createGoogleWallet>[0]> = {}) => ({
  GOOGLE_WALLET_MODE: 'auto' as const,
  GOOGLE_WALLET_ISSUER_ID: ISSUER,
  GOOGLE_WALLET_SA_JSON_PATH: saPath,
  ...o,
});

describe('configuración de Google Wallet: de simulado a real solo con credenciales', () => {
  it('auto sin credenciales → simulado (y dice qué falta)', async () => {
    const r = await createGoogleWallet(
      env({ GOOGLE_WALLET_ISSUER_ID: undefined, GOOGLE_WALLET_SA_JSON_PATH: '/no/existe.json' }),
      'http://localhost:5173',
    );
    expect(r.provider?.mode).toBe('simulated');
    expect(r.provider?.issuerRef).toBe(`google-sim:${SIMULATED_ISSUER_ID}`);
    expect(r.summary).toContain('falta GOOGLE_WALLET_ISSUER_ID');
  });

  it('auto con Issuer ID, cuenta de servicio y https → real', async () => {
    const r = await createGoogleWallet(env(), 'https://abc.trycloudflare.com');
    expect(r.provider?.mode).toBe('live');
    expect(r.provider?.issuerRef).toBe(`google:${ISSUER}`);
    expect(r.summary).toContain('REAL');
    expect(r.summary).not.toContain('PRIVATE KEY');
  });

  it('auto con credenciales pero sin https → simulado (Google no puede bajar el logo)', async () => {
    const r = await createGoogleWallet(env(), 'http://localhost:5173');
    expect(r.provider?.mode).toBe('simulated');
    expect(r.summary).toContain('https');
  });

  it('live con algo mal → no arranca y explica cada problema', async () => {
    await expect(
      createGoogleWallet(
        env({
          GOOGLE_WALLET_MODE: 'live',
          GOOGLE_WALLET_ISSUER_ID: 'abc',
          GOOGLE_WALLET_SA_JSON_PATH: badPath,
        }),
        'http://localhost:5173',
      ),
    ).rejects.toThrow(/ISSUER_ID[\s\S]*client_email[\s\S]*https/);
  });

  it('simulated fuerza el simulado aunque haya credenciales; off lo desactiva', async () => {
    expect(
      (await createGoogleWallet(env({ GOOGLE_WALLET_MODE: 'simulated' }), 'https://x.test')).provider?.mode,
    ).toBe('simulated');
    expect(
      (await createGoogleWallet(env({ GOOGLE_WALLET_MODE: 'off' }), 'https://x.test')).provider,
    ).toBeNull();
  });
});
