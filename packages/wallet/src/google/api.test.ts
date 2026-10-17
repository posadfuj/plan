import { decodeJwt, exportPKCS8, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { GoogleApiError, HttpGoogleWalletApi } from './api';
import type { GoogleServiceAccount } from './save-link';

let sa: GoogleServiceAccount;
beforeAll(async () => {
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  sa = { client_email: 'wallet@demo.iam.gserviceaccount.com', private_key: await exportPKCS8(privateKey) };
});

interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

/** fetch falso: responde en orden; registra cada pedido. */
function fakeFetch(responses: (Response | Error)[]) {
  const seen: Seen[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    seen.push({
      url,
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: String(init.body ?? ''),
    });
    const r = responses.shift();
    if (!r) throw new Error('sin respuesta preparada');
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  return { fn, seen };
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const token = (value = 'tok-1') => json(200, { access_token: value, expires_in: 3600, token_type: 'Bearer' });

describe('API real de Google Wallet (HTTP)', () => {
  it('pide un token OAuth con la cuenta de servicio, lo reutiliza y llama a walletobjects', async () => {
    const { fn, seen } = fakeFetch([token(), json(200, {}), json(200, {})]);
    const api = new HttpGoogleWalletApi({ serviceAccount: sa, fetch: fn });
    await api.patchObject('3388.aw_1', { state: 'ACTIVE' });
    await api.patchObject('3388.aw_1', { state: 'ACTIVE' });

    expect(seen).toHaveLength(3); // un solo token para las dos llamadas
    expect(seen[0]!.url).toBe('https://oauth2.googleapis.com/token');
    const form = new URLSearchParams(seen[0]!.body);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const assertion = decodeJwt(form.get('assertion')!);
    expect(assertion).toMatchObject({
      iss: sa.client_email,
      aud: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/wallet_object.issuer',
    });
    expect(seen[1]).toMatchObject({
      url: 'https://walletobjects.googleapis.com/walletobjects/v1/loyaltyObject/3388.aw_1',
      method: 'PATCH',
    });
    expect(seen[1]!.headers.get('authorization')).toBe('Bearer tok-1');
    expect(JSON.parse(seen[1]!.body)).toEqual({ state: 'ACTIVE' });
  });

  it('un 401 renueva el token una sola vez', async () => {
    const { fn, seen } = fakeFetch([token('viejo'), json(401, {}), token('nuevo'), json(200, {})]);
    const api = new HttpGoogleWalletApi({ serviceAccount: sa, fetch: fn });
    await api.patchObject('3388.aw_1', {});
    expect(seen.at(-1)!.headers.get('authorization')).toBe('Bearer nuevo');
  });

  it('clasifica los errores: caída o límite = reintentable; datos, permisos o credenciales = no', async () => {
    const cases: [Response | Error, number, boolean][] = [
      [json(503, { error: { message: 'Backend Error' } }), 503, true],
      [json(429, { error: { message: 'Quota' } }), 429, true],
      [new TypeError('fetch failed'), 0, true],
      [json(404, { error: { message: 'not found' } }), 404, false],
      [json(409, { error: { message: 'exists' } }), 409, false],
      [json(400, { error: { message: 'Invalid barcode' } }), 400, false],
      [json(403, { error: { message: 'Permission denied' } }), 403, false],
    ];
    for (const [response, status, retryable] of cases) {
      const { fn } = fakeFetch([token(), response]);
      const err = await new HttpGoogleWalletApi({ serviceAccount: sa, fetch: fn })
        .insertObject({ id: 'x' } as never)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GoogleApiError);
      expect([(err as GoogleApiError).status, (err as GoogleApiError).retryable]).toEqual([
        status,
        retryable,
      ]);
    }
  });

  it('credenciales rechazadas al pedir el token: no se reintenta', async () => {
    const { fn } = fakeFetch([
      json(400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }),
    ]);
    const err = (await new HttpGoogleWalletApi({ serviceAccount: sa, fetch: fn })
      .insertClass({ id: 'c' } as never)
      .catch((e: unknown) => e)) as GoogleApiError;
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('Invalid JWT Signature');
  });
});
