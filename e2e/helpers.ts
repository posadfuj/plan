import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { loadRootEnv } from '@aiment/config';
import { SEED, type SeedOrgKey } from '@aiment/db/seed-data';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import postgres from 'postgres';
import QRCode from 'qrcode';
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

// ---------------------------------------------------------------------------
// Caja
// ---------------------------------------------------------------------------
/**
 * QR de autorización de un dispositivo de caja. Con Supabase Auth local (E2E_AUTH) la prueba lo
 * genera el dueño desde el panel; sin Auth (CI) se crea en la base igual que lo hace la API.
 */
export async function pairingCodeFromDb(orgKey: SeedOrgKey = 'barberia', name = 'Celular del mostrador') {
  loadRootEnv();
  const org = SEED.orgs[orgKey];
  const code = Array.from(randomBytes(22), (b) => BASE62[b % 62]).join('');
  const sql = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });
  try {
    await sql`insert into app.device_pairings (organization_id, branch_id, name, code_hash, created_by, expires_at)
      values (${org.id}, ${org.branchId}, ${name}, ${createHash('sha256').update(code).digest('hex')},
              ${org.owner.orgUserId}, now() + interval '10 minutes')`;
  } finally {
    await sql.end();
  }
  return code;
}
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * Video Y4M con un QR en el centro, para la cámara simulada de Chromium
 * (--use-file-for-fake-video-capture): así la caja escanea "de verdad" con su cámara.
 */
export async function qrVideo(text: string, path: string, width = 640, height = 480) {
  const png = PNG.sync.read(
    await QRCode.toBuffer(text, { margin: 4, width: 360, errorCorrectionLevel: 'M' }),
  );
  const y = Buffer.alloc(width * height, 235); // fondo claro (mesa/luz de local)
  const ox = Math.floor((width - png.width) / 2);
  const oy = Math.floor((height - png.height) / 2);
  for (let r = 0; r < png.height; r++)
    for (let c = 0; c < png.width; c++) {
      const i = (r * png.width + c) * 4;
      const luma = 0.299 * png.data[i]! + 0.587 * png.data[i + 1]! + 0.114 * png.data[i + 2]!;
      y[(oy + r) * width + ox + c] = Math.round(16 + (luma * 219) / 255);
    }
  const chroma = Buffer.alloc((width / 2) * (height / 2) * 2, 128);
  const frame = Buffer.concat([Buffer.from('FRAME\n'), y, chroma]);
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from(`YUV4MPEG2 W${width} H${height} F10:1 Ip A1:1 C420jpeg\n`),
      frame,
      frame,
      frame,
    ]),
  );
}
