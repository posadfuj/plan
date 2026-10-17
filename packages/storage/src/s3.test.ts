import { describe, expect, it } from 'vitest';
import { S3Storage } from './s3';

/** fetch falso: registra el pedido firmado y responde lo preparado. */
function fakeFetch(respond: (req: Request) => Response) {
  const seen: Request[] = [];
  const fn = (async (input: Request) => {
    seen.push(input);
    return respond(input);
  }) as unknown as typeof fetch;
  return { fn, seen };
}

const opts = {
  endpoint: 'https://cuenta123.r2.cloudflarestorage.com/',
  bucket: 'aiment-archivos',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'secreto-de-prueba',
};

describe('almacenamiento en R2 (compatible con S3)', () => {
  it('guarda con un PUT firmado (SigV4) en la ruta del bucket', async () => {
    const { fn, seen } = fakeFetch(() => new Response(null, { status: 200 }));
    await new S3Storage({ ...opts, fetch: fn }).put(
      'logos/org-1/abc.png',
      new Uint8Array([1, 2, 3]),
      'image/png',
    );
    const req = seen[0]!;
    expect(req.method).toBe('PUT');
    expect(req.url).toBe('https://cuenta123.r2.cloudflarestorage.com/aiment-archivos/logos/org-1/abc.png');
    expect(req.headers.get('authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request/,
    );
    expect(req.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await req.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('lee el archivo con su tipo; si no existe devuelve null; otro error se informa', async () => {
    const ok = fakeFetch(
      () => new Response(new Uint8Array([9]), { headers: { 'content-type': 'image/webp' } }),
    );
    expect(await new S3Storage({ ...opts, fetch: ok.fn }).get('logos/o/x.webp')).toEqual({
      bytes: new Uint8Array([9]),
      contentType: 'image/webp',
    });
    const missing = fakeFetch(() => new Response('NoSuchKey', { status: 404 }));
    expect(await new S3Storage({ ...opts, fetch: missing.fn }).get('logos/o/x.png')).toBeNull();
    const down = fakeFetch(() => new Response('', { status: 503 }));
    await expect(new S3Storage({ ...opts, fetch: down.fn }).get('logos/o/x.png')).rejects.toThrow(/503/);
  });

  it('rechaza claves fuera del formato (sin pedir nada a R2)', async () => {
    const { fn, seen } = fakeFetch(() => new Response(null));
    const s = new S3Storage({ ...opts, fetch: fn });
    await expect(s.put('../secretos.png', new Uint8Array([1]), 'image/png')).rejects.toThrow(
      /clave inválida/,
    );
    expect(await s.get('logos/../../x.png')).toBeNull();
    expect(seen).toHaveLength(0);
  });
});
