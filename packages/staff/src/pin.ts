/**
 * PIN de caja: 4 a 6 dígitos, guardado con argon2id. Nunca se guarda ni se registra en claro.
 */
import { hash, verify } from '@node-rs/argon2';
import { StaffError } from './errors';

export const PIN_MAX_ATTEMPTS = 5;
export const PIN_LOCK_MINUTES = 15;

const SEQUENCE = '0123456789';

/** true si el PIN es fácil de adivinar: todos iguales (1111) o consecutivos (1234, 9876). */
export function isTrivialPin(pin: string): boolean {
  if (/^(\d)\1+$/.test(pin)) return true;
  const reversed = [...SEQUENCE].reverse().join('');
  return SEQUENCE.includes(pin) || reversed.includes(pin);
}

export function assertValidPin(pin: unknown): asserts pin is string {
  if (typeof pin !== 'string' || !/^\d{4,6}$/.test(pin))
    throw new StaffError(422, 'invalid_pin_format', 'El PIN debe tener de 4 a 6 números');
  if (isTrivialPin(pin))
    throw new StaffError(422, 'weak_pin', 'Elige un PIN difícil de adivinar (no 1234, 1111, 9876…)');
}

export function hashPin(pin: string): Promise<string> {
  return hash(pin);
}

export async function verifyPin(pinHash: string | null, pin: string): Promise<boolean> {
  if (!pinHash || typeof pin !== 'string' || !/^\d{4,6}$/.test(pin)) return false;
  try {
    return await verify(pinHash, pin);
  } catch {
    return false;
  }
}
