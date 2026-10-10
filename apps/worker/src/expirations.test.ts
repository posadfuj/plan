import { describe, expect, it } from 'vitest';
import { localHour } from './expirations';

describe('hora local de cada negocio', () => {
  it('convierte la hora UTC a la zona horaria del negocio', () => {
    const now = new Date('2026-10-10T08:30:00Z');
    expect(localHour(now, 'America/Lima')).toBe(3); // UTC−5, sin horario de verano
    expect(localHour(now, 'Asia/Tokyo')).toBe(17);
    expect(localHour(new Date('2026-10-10T05:00:00Z'), 'America/Lima')).toBe(0); // medianoche = 0, no 24
  });

  it('una zona horaria inválida lanza error (el trabajo la omite en lugar de adivinar)', () => {
    expect(() => localHour(new Date(), 'Lima/Peru')).toThrow();
  });
});
