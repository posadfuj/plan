import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import type { Locator } from '@playwright/test';

export const MAILPIT = process.env.MAILPIT_URL ?? 'http://127.0.0.1:54324';

export const randomPhone = () => `9${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
export const randomEmail = (tag: string) =>
  `${tag}.${Date.now()}.${Math.floor(Math.random() * 1e6)}@aiment.test`;

/** Lee el QR tal como lo vería una cámara: captura de pantalla + decodificación. */
export async function decodeQr(locator: Locator): Promise<string> {
  const png = PNG.sync.read(await locator.screenshot());
  const code = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  if (!code) throw new Error('No se pudo leer el QR de la pantalla');
  return code.data;
}

/** Espera el correo más reciente para una dirección en Mailpit y devuelve su texto. */
export async function waitForEmail(to: string, timeoutMs = 15_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    if (res.ok) {
      const data = (await res.json()) as { messages?: { ID: string }[] };
      const id = data.messages?.[0]?.ID;
      if (id) {
        const msg = (await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json()) as { Text: string };
        return msg.Text;
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`No llegó el correo para ${to}`);
}
