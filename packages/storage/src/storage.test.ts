import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalDiskStorage, MemoryStorage, sniffImage } from './index';

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const jpg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const webp = new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ');
const svg = new TextEncoder().encode('<svg><script>alert(1)</script></svg>');

describe('validación de imágenes por contenido', () => {
  it('reconoce PNG, JPEG y WebP y rechaza SVG, HTML o vacío', () => {
    expect(sniffImage(png)?.ext).toBe('png');
    expect(sniffImage(jpg)?.contentType).toBe('image/jpeg');
    expect(sniffImage(webp)?.ext).toBe('webp');
    for (const bad of [svg, new TextEncoder().encode('<html>'), new Uint8Array()])
      expect(sniffImage(bad)).toBeNull();
  });
});

describe('almacenamiento', () => {
  const dirs: string[] = [];
  afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

  it('en disco: guarda y lee; claves inválidas o con ".." no llegan al disco', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiment-storage-'));
    dirs.push(dir);
    const s = new LocalDiskStorage(dir);
    await s.put('logos/org-1/abc123.png', png, 'image/png');
    expect(await s.get('logos/org-1/abc123.png')).toEqual({ bytes: png, contentType: 'image/png' });
    await expect(s.put('../fuera.png', png, 'image/png')).rejects.toThrow(/clave inválida/);
    await expect(s.put('logos/x/y.svg', svg, 'image/svg+xml')).rejects.toThrow(/clave inválida/);
    expect(await s.get('logos/../../etc/passwd')).toBeNull();
    expect(await s.get('logos/org-1/no-existe.png')).toBeNull();
  });

  it('en memoria (tests): misma interfaz', async () => {
    const s = new MemoryStorage();
    await s.put('logos/o/a.jpg', jpg, 'image/jpeg');
    expect((await s.get('logos/o/a.jpg'))?.contentType).toBe('image/jpeg');
    expect(await s.get('LOGOS/o/a.jpg')).toBeNull();
  });
});
