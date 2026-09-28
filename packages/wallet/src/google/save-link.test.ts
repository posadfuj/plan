import { exportPKCS8, generateKeyPair, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import type { MembershipView } from '../types';
import { buildGoogleSaveUrl } from './save-link';

const view: MembershipView = {
  membershipId: 'm1',
  organizationId: 'o1',
  organizationName: 'Barbería Pedro',
  programName: 'Club Barbería Pedro',
  mode: 'stamps',
  unitLabel: 'sellos',
  balance: 7,
  goal: 10,
  availableRewards: 0,
  customerDisplayName: 'Ana Q.',
  scanUrl: 'http://localhost:5173/s/abc',
  shortCode: 'K7Q2MZ',
  primaryColor: '#1F2937',
};

describe('enlace Guardar en Google Wallet', () => {
  it('firma un JWT savetowallet válido con clase y objeto de fidelización', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
    const sa = {
      client_email: 'wallet@demo.iam.gserviceaccount.com',
      private_key: await exportPKCS8(privateKey),
    };
    const out = await buildGoogleSaveUrl({
      issuerId: '3388000000012345678',
      serviceAccount: sa,
      view,
      classSuffix: 'aw_demo_barberia',
      objectSuffix: 'aw_demo m1',
      logoUrl: 'https://example.com/logo.png',
    });

    expect(out.url.startsWith('https://pay.google.com/gp/v/save/')).toBe(true);
    const { payload, protectedHeader } = await jwtVerify(out.jwt, publicKey, {
      audience: 'google',
      issuer: sa.client_email,
    });
    expect(protectedHeader.alg).toBe('RS256');
    expect(payload.typ).toBe('savetowallet');
    const body = payload.payload as {
      loyaltyClasses: Record<string, unknown>[];
      loyaltyObjects: {
        id: string;
        classId: string;
        loyaltyPoints: { balance: { int: number } };
        barcode: unknown;
      }[];
    };
    expect(body.loyaltyClasses[0]).toMatchObject({
      id: '3388000000012345678.aw_demo_barberia',
      issuerName: 'Barbería Pedro',
    });
    const obj = body.loyaltyObjects[0]!;
    expect(obj.id).toBe('3388000000012345678.aw_demo_m1');
    expect(obj.classId).toBe('3388000000012345678.aw_demo_barberia');
    expect(obj.loyaltyPoints.balance.int).toBe(7);
    expect(obj.barcode).toEqual({ type: 'QR_CODE', value: view.scanUrl, alternateText: 'K7Q2MZ' });
  });
});
