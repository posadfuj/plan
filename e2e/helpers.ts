import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { loadRootEnv } from '@aiment/config';
import { SEED, type SeedOrgKey } from '@aiment/db/seed-data';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import postgres from 'postgres';
import QRCode from 'qrcode';
import type { Locator, Page } from '@playwright/test';
import { SignJWT } from 'jose';

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

// ---------------------------------------------------------------------------
// Panel (semana 5)
// ---------------------------------------------------------------------------
/**
 * Sesión del panel. Con Supabase Auth local (E2E_AUTH) se entra con correo y contraseña reales;
 * en CI (sin Supabase Auth) se guarda en el navegador una sesión firmada igual que la emite Supabase
 * (HS256 con SUPABASE_JWT_SECRET), así el panel se prueba completo también en CI.
 */
export async function panelLogin(page: Page, user: { id: string; email: string }, path = '/panel') {
  loadRootEnv();
  if (process.env.E2E_AUTH) {
    await page.goto(path);
    await page.getByPlaceholder('Correo').fill(user.email);
    await page.getByPlaceholder('Contraseña').fill(process.env.SEED_USER_PASSWORD ?? 'aiment-demo-2026');
    await page.getByRole('button', { name: 'Entrar' }).click();
    return;
  }
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) throw new Error('E2E sin Supabase Auth: falta SUPABASE_JWT_SECRET');
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = await new SignJWT({ role: 'authenticated', aal: 'aal1', email: user.email })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuer(`${(process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321').replace(/\/$/, '')}/auth/v1`)
    .setAudience('authenticated')
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode(secret));
  const session = {
    access_token: token,
    refresh_token: 'e2e-sin-refresh',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: exp,
    user: {
      id: user.id,
      aud: 'authenticated',
      role: 'authenticated',
      email: user.email,
      app_metadata: {},
      user_metadata: {},
    },
  };
  await page.addInitScript((s) => localStorage.setItem('aiment.panel.auth', s), JSON.stringify(session));
  await page.goto(path);
}

/** Imagen grande tipo foto de celular (1200×900), para probar que el panel la achica antes de subirla. */
export function photoPng(path: string) {
  const png = new PNG({ width: 1200, height: 900 });
  for (let y = 0; y < png.height; y++)
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      png.data[i] = (x * 7 + y * 3) % 256;
      png.data[i + 1] = (x * 3 + y * 11) % 256;
      png.data[i + 2] = 140;
      png.data[i + 3] = 255;
    }
  writeFileSync(path, PNG.sync.write(png));
  return path;
}

/**
 * Negocio nuevo para una prueba sin Supabase Auth (CI): se crea con el mismo servicio que usa el panel
 * maestro, con un proveedor de cuentas simulado. Con Supabase Auth, la prueba lo crea desde /admin.
 */
export async function createBusinessInDb(name: string, ownerEmail: string) {
  loadRootEnv();
  const { createDb } = await import('@aiment/db');
  const { createBusiness } = await import('@aiment/business');
  const { MemoryMailer } = await import('@aiment/mail');
  const handle = createDb(process.env.DATABASE_URL!, { max: 2 });
  const userId = randomUUID();
  try {
    const r = await createBusiness(
      {
        db: handle.db,
        mailer: new MemoryMailer(),
        publicBaseUrl: 'http://localhost',
        authAdmin: { createAccessLink: async () => ({ userId, tokenHash: 'x', type: 'invite' as const }) },
      },
      SEED.superadmin.id,
      { name, template: 'lavanderia', planCode: 'multi', ownerEmail, ownerName: 'Marta Peña' },
    );
    return { orgId: r.organization.id, owner: { id: userId, email: ownerEmail } };
  } finally {
    await handle.close();
  }
}

/** Llamada del superadmin a la API (CI): misma firma que Supabase Auth. */
export async function superadminApi(baseURL: string, method: string, path: string) {
  loadRootEnv();
  const token = await new SignJWT({ role: 'authenticated', aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(SEED.superadmin.id)
    .setIssuer(`${(process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321').replace(/\/$/, '')}/auth/v1`)
    .setAudience('authenticated')
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET!));
  const res = await fetch(new URL(path, baseURL), { method, headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}
