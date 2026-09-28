/**
 * Archivos del negocio (por ahora, el logo). Interfaz tipo S3 con claves planas:
 * local = carpeta en disco (`.data/storage`), tests = memoria, producción (semana 9) = R2/S3
 * con la misma interfaz. Cambiar de proveedor es solo configuración.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export interface StoredObject {
  bytes: Uint8Array;
  contentType: string;
}

export interface ObjectStorage {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
}

/** Claves: segmentos [a-z0-9-] separados por "/", con extensión. Nada de "..", ni rutas absolutas. */
export const KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}(\/[a-z0-9][a-z0-9-]{0,63}){1,3}\.(png|jpg|webp)$/;

function assertKey(key: string) {
  if (!KEY_RE.test(key)) throw new Error(`storage: clave inválida (${key})`);
}

export class MemoryStorage implements ObjectStorage {
  readonly objects = new Map<string, StoredObject>();
  async put(key: string, bytes: Uint8Array, contentType: string) {
    assertKey(key);
    this.objects.set(key, { bytes: new Uint8Array(bytes), contentType });
  }
  async get(key: string) {
    if (!KEY_RE.test(key)) return null;
    return this.objects.get(key) ?? null;
  }
}

const TYPE_BY_EXT: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

/** Carpeta local. El tipo se deduce de la extensión (las claves solo admiten imágenes validadas). */
export class LocalDiskStorage implements ObjectStorage {
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  private path(key: string) {
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + '/') && !p.startsWith(this.root + '\\'))
      throw new Error('storage: ruta fuera de la carpeta');
    return p;
  }
  async put(key: string, bytes: Uint8Array, _contentType?: string) {
    assertKey(key);
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, p);
  }
  async get(key: string) {
    if (!KEY_RE.test(key)) return null;
    try {
      const bytes = await readFile(this.path(key));
      return { bytes: new Uint8Array(bytes), contentType: TYPE_BY_EXT[key.split('.').pop()!]! };
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Validación de imágenes subidas (por contenido, nunca por el nombre o el tipo declarado)
// ---------------------------------------------------------------------------
export const MAX_LOGO_BYTES = 1024 * 1024;

export type ImageKind = { ext: 'png' | 'jpg' | 'webp'; contentType: string };

/** Reconoce PNG, JPEG y WebP por sus primeros bytes. SVG y otros formatos se rechazan (pueden llevar scripts). */
export function sniffImage(bytes: Uint8Array): ImageKind | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return { ext: 'png', contentType: 'image/png' };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return { ext: 'jpg', contentType: 'image/jpeg' };
  if (
    b.length >= 12 &&
    String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!) === 'RIFF' &&
    String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!) === 'WEBP'
  )
    return { ext: 'webp', contentType: 'image/webp' };
  return null;
}
