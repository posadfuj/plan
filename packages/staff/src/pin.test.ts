import { describe, expect, it } from 'vitest';
import { assertValidPin, hashPin, isTrivialPin, verifyPin } from './pin';

describe('PIN de caja', () => {
  it('rechaza PIN fáciles de adivinar', () => {
    for (const pin of ['1111', '000000', '1234', '3456', '123456', '9876', '6543', '0123'])
      expect(isTrivialPin(pin), pin).toBe(true);
    for (const pin of ['2580', '1470', '5829', '193746']) expect(isTrivialPin(pin), pin).toBe(false);
  });

  it('exige de 4 a 6 números', () => {
    for (const pin of ['123', '1234567', '12a4', '', null, 2580])
      expect(() => assertValidPin(pin), String(pin)).toThrow();
    expect(() => assertValidPin('2580')).not.toThrow();
  });

  it('se guarda con argon2id y se verifica sin revelar el PIN', async () => {
    const h = await hashPin('2580');
    expect(h).toMatch(/^\$argon2id\$/);
    expect(h).not.toContain('2580');
    expect(await verifyPin(h, '2580')).toBe(true);
    expect(await verifyPin(h, '2581')).toBe(false);
    expect(await verifyPin(null, '2580')).toBe(false);
    expect(await verifyPin('no-es-un-hash', '2580')).toBe(false);
  });
});
