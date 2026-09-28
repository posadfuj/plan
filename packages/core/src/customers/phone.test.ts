import { describe, expect, it } from 'vitest';
import { maskPhone, normalizePhone } from './phone';

describe('normalizePhone', () => {
  it('acepta los formatos habituales de un celular peruano', () => {
    for (const input of [
      '987654321',
      '987 654 321',
      '987-654-321',
      '+51 987 654 321',
      '51987654321',
      '0051987654321',
      '(+51) 987654321',
    ])
      expect(normalizePhone(input), input).toBe('+51987654321');
  });

  it('rechaza fijos peruanos, longitudes erróneas y texto', () => {
    for (const input of [
      '014567890',
      '12345678',
      '98765432',
      '9876543210',
      '+51 1 4567890',
      'abc987654321',
      '',
      '+',
      '+51+987654321',
    ])
      expect(normalizePhone(input), input).toBeNull();
  });

  it('acepta otros países solo con prefijo internacional', () => {
    expect(normalizePhone('+34 612 345 678')).toBe('+34612345678');
    expect(normalizePhone('+1 (415) 555-0100')).toBe('+14155550100');
    expect(normalizePhone('612345678', '34')).toBeNull();
  });

  it('enmascara para mostrar', () => {
    expect(maskPhone('+51987654321')).toBe('+51 987 *** 321');
  });
});
