/**
 * API REST de Google Wallet (walletobjects v1), solo lo que usa Aiment: clases y objetos de
 * fidelización. Dos implementaciones con el mismo contrato: la real (HTTP + OAuth de la cuenta de
 * servicio) y la simulada (memoria, ver simulated.ts). Pasar de una a otra es configuración.
 */
import { importPKCS8, SignJWT } from 'jose';
import { WalletProviderError } from '../types';
import type { LoyaltyClass, LoyaltyObject } from './payload';
import type { GoogleServiceAccount } from './save-link';

export interface GoogleWalletApi {
  /** 409 si ya existe. */
  insertClass(c: LoyaltyClass): Promise<void>;
  /** 409 si ya existe; 404 si la clase no existe. */
  insertObject(o: LoyaltyObject): Promise<void>;
  /** Cambia solo los campos enviados. 404 si el objeto no existe (el cliente aún no lo guardó). */
  patchObject(id: string, o: Record<string, unknown>): Promise<void>;
  /** Cambia la clase (marca del programa). 404 si nadie guardó todavía un pase de esa clase. */
  patchClass(id: string, c: Record<string, unknown>): Promise<void>;
  /** Mensaje en el pase; con TEXT_AND_NOTIFY llega como notificación. 409 si ya se envió ese id. */
  addMessage(objectId: string, message: GoogleMessage): Promise<void>;
}

export interface GoogleMessage {
  id: string;
  header: string;
  body: string;
  messageType: 'TEXT' | 'TEXT_AND_NOTIFY';
}

/** Error de la API de Google. `retryable` decide si el worker lo reintenta. */
export class GoogleApiError extends WalletProviderError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    // 408/429/5xx y fallos de red (status 0): pasajeros. 400/401/403: datos o permisos, no se arreglan solos.
    super(message, status === 0 || status === 408 || status === 429 || status >= 500);
    this.name = 'GoogleApiError';
  }
}
export const isNotFound = (e: unknown) => e instanceof GoogleApiError && e.status === 404;
export const isConflict = (e: unknown) => e instanceof GoogleApiError && e.status === 409;

const API_BASE = 'https://walletobjects.googleapis.com/walletobjects/v1';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/wallet_object.issuer';

export interface HttpGoogleWalletApiOptions {
  serviceAccount: GoogleServiceAccount;
  /** Inyectable en tests. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Cliente real: OAuth 2.0 con JWT de la cuenta de servicio (sin dependencias de Google). */
export class HttpGoogleWalletApi implements GoogleWalletApi {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: HttpGoogleWalletApiOptions) {
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  insertClass(c: LoyaltyClass) {
    return this.call('POST', '/loyaltyClass', c);
  }
  insertObject(o: LoyaltyObject) {
    return this.call('POST', '/loyaltyObject', o);
  }
  patchObject(id: string, o: Record<string, unknown>) {
    return this.call('PATCH', `/loyaltyObject/${encodeURIComponent(id)}`, o);
  }
  patchClass(id: string, c: Record<string, unknown>) {
    return this.call('PATCH', `/loyaltyClass/${encodeURIComponent(id)}`, c);
  }
  addMessage(objectId: string, message: GoogleMessage) {
    return this.call('POST', `/loyaltyObject/${encodeURIComponent(objectId)}/addMessage`, { message });
  }

  private async call(method: string, path: string, body: unknown, retriedAuth = false): Promise<void> {
    const res = await this.request(`${API_BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    // Token vencido o revocado antes de tiempo: se pide uno nuevo una sola vez.
    if (res.status === 401 && !retriedAuth) {
      this.token = null;
      return this.call(method, path, body, true);
    }
    if (!res.ok)
      throw new GoogleApiError(
        res.status,
        `Google Wallet ${method} ${path.split('/')[1]}: ${await describe(res)}`,
      );
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const sa = this.opts.serviceAccount;
    const assertion = await new SignJWT({ scope: SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(sa.client_email)
      .setAudience(TOKEN_URL)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(await importPKCS8(sa.private_key, 'RS256'));
    const res = await this.request(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
    if (!res.ok) {
      // 400/401 aquí = credenciales inválidas o revocadas: reintentar no sirve.
      const status = res.status >= 500 ? res.status : 403;
      throw new GoogleApiError(status, `Google OAuth: ${await describe(res)}`);
    }
    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    return data.access_token;
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw new GoogleApiError(0, `Google Wallet sin respuesta: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/** Mensaje corto del error de Google (sin datos del cliente: solo código y descripción). */
async function describe(res: Response): Promise<string> {
  const data = (await res.json().catch(() => null)) as {
    error?: { message?: string } | string;
    error_description?: string;
  } | null;
  const msg =
    typeof data?.error === 'object' ? data.error.message : (data?.error_description ?? data?.error ?? '');
  return `${res.status}${msg ? ` ${String(msg).slice(0, 200)}` : ''}`;
}
