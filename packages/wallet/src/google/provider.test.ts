import { decodeJwt, exportPKCS8, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import type { MembershipView, WalletPassRef } from '../types';
import { GoogleApiError } from './api';
import { googleClassId, type LoyaltyClass, type LoyaltyObject } from './payload';
import { GoogleWalletProvider } from './provider';
import type { GoogleServiceAccount } from './save-link';
import { SimulatedGoogleWalletApi } from './simulated';

const ISSUER = '3388000000012345678';
const view: MembershipView = {
  membershipId: 'm1',
  organizationId: 'o1',
  organizationName: 'Barbería Pedro',
  programId: 'p1',
  programName: 'Club Barbería Pedro',
  mode: 'stamps',
  unitLabel: 'sellos',
  balance: 7,
  goal: 10,
  availableRewards: 0,
  customerDisplayName: 'Ana Q.',
  scanUrl: 'https://aiment.test/s/abc',
  shortCode: 'K7Q2MZ',
  primaryColor: '#7C3AED',
  logoUrl: 'https://aiment.test/v1/public/files/logos/o1/logo.png',
  status: 'active',
  message: null,
};

let sa: GoogleServiceAccount;
beforeAll(async () => {
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  sa = { client_email: 'wallet@demo.iam.gserviceaccount.com', private_key: await exportPKCS8(privateKey) };
});

function setup(mode: 'live' | 'simulated' = 'simulated') {
  const api = new SimulatedGoogleWalletApi();
  const provider = new GoogleWalletProvider({
    mode,
    issuerId: ISSUER,
    serviceAccount: sa,
    api,
    publicBaseUrl: 'https://aiment.test/',
  });
  return { api, provider };
}

/** Lo que trae el JWT del enlace (payload sin verificar: la firma la prueba save-link.test.ts). */
function jwtPayload(url: string) {
  const jwt = url.split(/\/save\/|#/).at(-1)!;
  return (decodeJwt(jwt) as { payload: { loyaltyClasses: LoyaltyClass[]; loyaltyObjects: LoyaltyObject[] } })
    .payload;
}

const ref = (p: GoogleWalletProvider, externalId: string): WalletPassRef => ({
  walletPassId: 'w1',
  provider: 'google',
  issuerRef: p.issuerRef,
  externalId,
});

describe('Google Wallet: enlace para agregar el pase', () => {
  it('modo simulado: abre la vista local con la clase (marca) y el objeto (saldo y QR)', async () => {
    const { api, provider } = setup();
    const r = await provider.issue(view);

    expect(r.issuerRef).toBe(`google-sim:${ISSUER}`);
    expect(r.externalId).toMatch(new RegExp(`^${ISSUER}\\.aw_[0-9a-f]{24}$`));
    expect(r.addUrl.startsWith('https://aiment.test/wallet/google-simulado#')).toBe(true);
    const { loyaltyClasses, loyaltyObjects } = jwtPayload(r.addUrl);
    expect(loyaltyClasses[0]).toMatchObject({
      id: googleClassId(ISSUER, 'p1'),
      issuerName: 'Barbería Pedro',
      programName: 'Club Barbería Pedro',
      hexBackgroundColor: '#7C3AED',
      programLogo: { sourceUri: { uri: view.logoUrl } },
    });
    expect(loyaltyObjects[0]).toMatchObject({
      id: r.externalId,
      classId: googleClassId(ISSUER, 'p1'),
      state: 'ACTIVE',
      accountName: 'Ana Q.',
      loyaltyPoints: { label: 'sellos (meta 10)', balance: { int: 7 } },
      barcode: { type: 'QR_CODE', value: view.scanUrl, alternateText: 'K7Q2MZ' },
    });
    expect(loyaltyObjects[0]!.textModulesData[0]!.body).toBe('7 de 10 sellos · te faltan 3');
    expect(api.calls).toHaveLength(0); // el enlace no llama a Google: funciona aunque esté caído
  });

  it('modo real: el enlace va a pay.google.com; reutilizar el pase conserva su id', async () => {
    const { provider } = setup('live');
    const first = await provider.issue(view);
    expect(first.issuerRef).toBe(`google:${ISSUER}`);
    expect(first.addUrl.startsWith('https://pay.google.com/gp/v/save/')).toBe(true);
    const again = await provider.issue({ ...view, balance: 8 }, first.externalId);
    expect(again.externalId).toBe(first.externalId);
    expect(jwtPayload(again.addUrl).loyaltyObjects[0]!.loyaltyPoints.balance.int).toBe(8);
  });

  it('sin logo compatible usa el logo por defecto de la PWA; cada programa tiene su propia clase', async () => {
    const { provider } = setup();
    const r = await provider.issue({ ...view, logoUrl: null, programId: 'p2' });
    const cls = jwtPayload(r.addUrl).loyaltyClasses[0]!;
    expect(cls.programLogo.sourceUri.uri).toBe('https://aiment.test/wallet-logo.png');
    expect(cls.id).toBe(googleClassId(ISSUER, 'p2'));
    expect(cls.id).not.toBe(googleClassId(ISSUER, 'p1'));
    expect(cls.id).not.toContain('p2'); // id opaco: no expone el id interno
  });

  it('tarjeta pausada: el pase no lleva QR y lo explica', async () => {
    const { provider } = setup();
    const obj = jwtPayload((await provider.issue({ ...view, status: 'blocked' })).addUrl).loyaltyObjects[0]!;
    expect(obj.barcode).toEqual({ type: 'TEXT_ONLY', value: 'Tarjeta pausada' });
    expect(JSON.stringify(obj)).not.toContain(view.scanUrl);
    expect(obj.textModulesData[0]).toMatchObject({ id: 'status', header: 'Tarjeta pausada' });
  });
});

describe('Google Wallet: actualizar y cerrar pases', () => {
  it('si el cliente aún no guardó el pase, lo crea con el estado actual; después lo actualiza', async () => {
    const { api, provider } = setup();
    const { externalId } = await provider.issue(view);

    await provider.update({ ...view, balance: 8 }, ref(provider, externalId));
    expect(api.calls.map((c) => c.op)).toEqual(['patchObject', 'insertClass', 'insertObject']);
    expect(api.classes.size).toBe(1);

    await provider.update({ ...view, balance: 9, availableRewards: 1 }, ref(provider, externalId));
    expect(api.calls.at(-1)!.op).toBe('patchObject');
    const obj = api.objects.get(externalId) as LoyaltyObject;
    expect(obj.loyaltyPoints.balance.int).toBe(9);
    expect(obj.secondaryLoyaltyPoints.balance.int).toBe(1);
  });

  it('si el cliente ya lo guardó desde el enlace, actualiza encima', async () => {
    const { api, provider } = setup();
    const issued = await provider.issue(view);
    api.saveFromJwt(jwtPayload(issued.addUrl)); // el cliente tocó "Guardar" en su Android
    await provider.update({ ...view, balance: 10 }, ref(provider, issued.externalId));
    expect(api.calls.map((c) => c.op)).toEqual(['patchObject']);
    expect((api.objects.get(issued.externalId) as LoyaltyObject).loyaltyPoints.balance.int).toBe(10);
  });

  it('una clase que ya existe (otro cliente del mismo programa) no es un error', async () => {
    const { api, provider } = setup();
    const a = await provider.issue(view);
    const b = await provider.issue({ ...view, membershipId: 'm2' });
    await provider.update(view, ref(provider, a.externalId));
    await provider.update(view, ref(provider, b.externalId));
    expect(api.objects.size).toBe(2);
    expect(api.classes.size).toBe(1);
  });

  it('pausar la tarjeta quita el QR del pase ya guardado; reactivarla lo devuelve', async () => {
    const { api, provider } = setup();
    const issued = await provider.issue(view);
    api.saveFromJwt(jwtPayload(issued.addUrl));
    await provider.update({ ...view, status: 'blocked' }, ref(provider, issued.externalId));
    expect(api.objects.get(issued.externalId)!.barcode).toEqual({
      type: 'TEXT_ONLY',
      value: 'Tarjeta pausada',
    });
    await provider.update(view, ref(provider, issued.externalId));
    expect(api.objects.get(issued.externalId)!.barcode).toMatchObject({
      type: 'QR_CODE',
      value: view.scanUrl,
    });
  });

  it('Google caído: el error es reintentable; datos o permisos rechazados, no', async () => {
    const { api, provider } = setup();
    const { externalId } = await provider.issue(view);
    api.down = true;
    const down = await provider.update(view, ref(provider, externalId)).catch((e: unknown) => e);
    expect(down).toBeInstanceOf(GoogleApiError);
    expect((down as GoogleApiError).retryable).toBe(true);

    api.down = false;
    api.failNext(1, 403);
    const denied = await provider.update(view, ref(provider, externalId)).catch((e: unknown) => e);
    expect((denied as GoogleApiError).retryable).toBe(false);

    await provider.update(view, ref(provider, externalId)); // vuelve Google: se pone al día
    expect((api.objects.get(externalId) as LoyaltyObject).loyaltyPoints.balance.int).toBe(7);
  });

  it('cliente eliminado: el pase queda inactivo, sin nombre ni QR que lo identifique', async () => {
    const { api, provider } = setup();
    const issued = await provider.issue(view);
    api.saveFromJwt(jwtPayload(issued.addUrl));
    await provider.revoke(ref(provider, issued.externalId));
    const obj = api.objects.get(issued.externalId)!;
    expect(obj.state).toBe('INACTIVE');
    expect(obj.accountName).toBe('Tarjeta cerrada');
    expect(JSON.stringify(obj)).not.toContain('Ana');
    expect(JSON.stringify(obj)).not.toContain(view.scanUrl);
    // Nunca lo guardó: no hay nada que cerrar en Google.
    await expect(provider.revoke(ref(provider, `${ISSUER}.aw_nunca`))).resolves.toBeUndefined();
  });

  it('solo atiende pases de su propia cuenta emisora', () => {
    const { provider } = setup();
    expect(provider.handles(`google-sim:${ISSUER}`)).toBe(true);
    expect(provider.handles(`google:${ISSUER}`)).toBe(false);
    expect(provider.handles('fake:google-local')).toBe(false);
  });
});

describe('Google Wallet: marca, programa y mensajes (bloque 2)', () => {
  it('cambiar nombre, color o logo actualiza la clase; si nadie guardó un pase, no hace nada', async () => {
    const { api, provider } = setup();
    const program = {
      organizationId: 'o1',
      organizationName: 'Barbería Pedro & Hijos',
      programId: 'p1',
      programName: 'Club Pedro',
      primaryColor: '#0F766E',
      logoUrl: null,
    };
    await expect(provider.updateProgram(program)).resolves.toBeUndefined(); // clase aún no existe
    expect(api.classes.size).toBe(0);

    const issued = await provider.issue(view);
    api.saveFromJwt(jwtPayload(issued.addUrl));
    await provider.updateProgram(program);
    expect(api.classes.get(googleClassId(ISSUER, 'p1'))).toMatchObject({
      issuerName: 'Barbería Pedro & Hijos',
      programName: 'Club Pedro',
      hexBackgroundColor: '#0F766E',
      programLogo: { sourceUri: { uri: 'https://aiment.test/wallet-logo.png' } },
      reviewStatus: 'UNDER_REVIEW',
    });
  });

  it('el pase muestra el mensaje automático vigente (no en una tarjeta pausada)', async () => {
    const { provider } = setup();
    const msg = '¡Completaste tu tarjeta! Canjea tu corte gratis en caja.';
    const obj = jwtPayload((await provider.issue({ ...view, message: msg })).addUrl).loyaltyObjects[0]!;
    expect(obj.textModulesData).toContainEqual({ id: 'message', header: 'Barbería Pedro', body: msg });
    const paused = jwtPayload((await provider.issue({ ...view, message: msg, status: 'blocked' })).addUrl)
      .loyaltyObjects[0]!;
    expect(paused.textModulesData.map((m) => m.id)).not.toContain('message');
  });

  it('notificación: llega una sola vez aunque se repita; sin pase guardado no falla', async () => {
    const { api, provider } = setup();
    const issued = await provider.issue(view);
    const notice = { id: 'aw_run-1', header: 'Barbería Pedro', body: '¡Completaste tu tarjeta!' };
    await provider.notify(view, ref(provider, issued.externalId), notice); // aún no lo guardó
    api.saveFromJwt(jwtPayload(issued.addUrl));
    await provider.notify(view, ref(provider, issued.externalId), notice);
    await provider.notify(view, ref(provider, issued.externalId), notice);
    expect(api.messages.get(issued.externalId)).toEqual([
      {
        id: 'aw_run-1',
        header: 'Barbería Pedro',
        body: '¡Completaste tu tarjeta!',
        messageType: 'TEXT_AND_NOTIFY',
      },
    ]);
  });
});
