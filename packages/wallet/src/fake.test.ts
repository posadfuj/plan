import { describe, expect, it } from 'vitest';
import { FakeWalletProvider } from './fake';
import { WalletProviderError } from './types';

describe('Wallet simulado', () => {
  it('registra operaciones y reconoce solo sus propias cuentas emisoras', async () => {
    const p = new FakeWalletProvider('google');
    expect(p.handles('fake:google-local')).toBe(true);
    expect(p.handles('google:3388000000012345678')).toBe(false);
    await p.revoke({ walletPassId: 'w', provider: 'google', issuerRef: p.issuerRef, externalId: 'x' });
    expect(p.calls).toHaveLength(1);
  });

  it('simula fallos reintentables', async () => {
    const p = new FakeWalletProvider('apple');
    p.failNext(1);
    const ref = { walletPassId: 'w', provider: 'apple' as const, issuerRef: p.issuerRef, externalId: 'x' };
    await expect(p.revoke(ref)).rejects.toBeInstanceOf(WalletProviderError);
    await expect(p.revoke(ref)).resolves.toBeUndefined();
  });
});
