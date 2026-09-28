import { createHash, randomBytes, randomInt } from 'node:crypto';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** Sin caracteres ambiguos (0/O, 1/I/L) para códigos que se dictan o se escriben a mano. */
const SHORT = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** Token secreto de 128 bits en base62 (22 caracteres). */
export function newToken(): string {
  let n = BigInt(`0x${randomBytes(16).toString('hex')}`);
  let out = '';
  while (n > 0n) {
    out = BASE62[Number(n % 62n)] + out;
    n /= 62n;
  }
  return out.padStart(22, '0');
}

export const TOKEN_RE = /^[0-9A-Za-z]{22}$/;
export const isToken = (v: string | undefined): v is string => !!v && TOKEN_RE.test(v);

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newShortCode(length = 6): string {
  return Array.from({ length }, () => SHORT[randomInt(SHORT.length)]).join('');
}
