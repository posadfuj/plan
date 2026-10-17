/**
 * Almacenamiento compatible con S3 (Cloudflare R2 en producción). Pedidos firmados con SigV4
 * (aws4fetch); sin el SDK de AWS. Misma interfaz que el disco local: cambiar es configuración.
 */
import { AwsClient } from 'aws4fetch';
import { KEY_RE, type ObjectStorage, type StoredObject } from './index';

export interface S3StorageOptions {
  /** R2: https://<account id>.r2.cloudflarestorage.com */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** R2 usa "auto". */
  region?: string;
  /** Inyectable en tests. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class S3Storage implements ObjectStorage {
  private readonly client: AwsClient;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: S3StorageOptions) {
    this.client = new AwsClient({
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      service: 's3',
      region: opts.region ?? 'auto',
    });
    this.base = `${opts.endpoint.replace(/\/$/, '')}/${encodeURIComponent(opts.bucket)}`;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    if (!KEY_RE.test(key)) throw new Error(`storage: clave inválida (${key})`);
    const res = await this.send(key, {
      method: 'PUT',
      body: bytes,
      headers: { 'content-type': contentType, 'content-length': String(bytes.byteLength) },
    });
    if (!res.ok) throw new Error(`storage: no se pudo guardar el archivo (${res.status})`);
  }

  async get(key: string): Promise<StoredObject | null> {
    if (!KEY_RE.test(key)) return null;
    const res = await this.send(key, { method: 'GET' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`storage: no se pudo leer el archivo (${res.status})`);
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    };
  }

  private async send(key: string, init: RequestInit): Promise<Response> {
    const url = `${this.base}/${key.split('/').map(encodeURIComponent).join('/')}`;
    const signed = await this.client.sign(url, init);
    return this.fetchImpl(signed, { signal: AbortSignal.timeout(this.timeoutMs) });
  }
}
