/**
 * PDF de mostrador por sucursal (semana 6): marca + QR de registro + "Powered by Aiment Wallet".
 * A5 vertical (también se imprime bien en A4). El QR es vectorial: no se pixela al imprimir.
 *
 * Fuentes estándar del PDF (WinAnsi): tildes, ñ, ¡ y ¿ salen bien; un carácter que no existe en esa
 * codificación (emoji, otros alfabetos) se reemplaza en lugar de romper el archivo.
 */
import { readBranding, textOn } from '@aiment/core';
import { schema, withTenantTx, type Db } from '@aiment/db';
import { printedUrls } from '@aiment/enrollment';
import type { ObjectStorage } from '@aiment/storage';
import { and, asc, eq } from 'drizzle-orm';
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import QRCode from 'qrcode';
import { BusinessError, notFound } from './errors';

const { organizations, branches, shortLinks, loyaltyPrograms, programRuleVersions, rewards } = schema;

const A5: [number, number] = [419.53, 595.28];
const MARGIN = 32;

function hex(color: string) {
  const n = parseInt(color.replace('#', ''), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** Texto que la fuente puede escribir (WinAnsi); lo demás se reemplaza. */
export function encodable(font: PDFFont, text: string): string {
  let out = '';
  for (const ch of text.normalize('NFC')) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += ch.trim() ? '?' : ' ';
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Parte un texto en líneas que entran en `width`. */
function wrap(font: PDFFont, text: string, size: number, width: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) <= width || !line) line = next;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Tamaño de letra que hace entrar el texto en `maxLines` líneas (de `max` hacia abajo). */
function fit(font: PDFFont, text: string, max: number, min: number, width: number, maxLines: number) {
  for (let size = max; size >= min; size -= 1) {
    const lines = wrap(font, text, size, width);
    if (lines.length <= maxLines) return { size, lines };
  }
  return { size: min, lines: wrap(font, text, min, width).slice(0, maxLines) };
}

function centered(page: PDFPage, font: PDFFont, text: string, size: number, y: number, color = rgb(0, 0, 0)) {
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: (A5[0] - w) / 2, y, size, font, color });
}

export interface CounterPdf {
  filename: string;
  bytes: Uint8Array;
}

export async function counterPdf(
  db: Db,
  storage: ObjectStorage,
  orgId: string,
  branchId: string,
  publicBaseUrl: string,
): Promise<CounterPdf> {
  const data = await withTenantTx(db, orgId, async (tx) => {
    const [org] = await tx
      .select({ name: organizations.name, slug: organizations.slug, branding: organizations.branding })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    const [branch] = await tx
      .select({
        name: branches.name,
        address: branches.address,
        status: branches.status,
        slug: shortLinks.slug,
      })
      .from(branches)
      .leftJoin(shortLinks, and(eq(shortLinks.branchId, branches.id), eq(shortLinks.kind, 'registration')))
      .where(and(eq(branches.id, branchId), eq(branches.organizationId, orgId)));
    const [program] = await tx
      .select({
        mode: loyaltyPrograms.mode,
        unitLabel: loyaltyPrograms.unitLabel,
        goal: programRuleVersions.goal,
      })
      .from(loyaltyPrograms)
      .innerJoin(programRuleVersions, eq(programRuleVersions.id, loyaltyPrograms.currentVersionId))
      .where(and(eq(loyaltyPrograms.organizationId, orgId), eq(loyaltyPrograms.status, 'active')));
    const [goalReward] = await tx
      .select({ name: rewards.name })
      .from(rewards)
      .where(and(eq(rewards.organizationId, orgId), eq(rewards.kind, 'goal'), eq(rewards.active, true)))
      .orderBy(asc(rewards.sortOrder))
      .limit(1);
    return { org, branch, program, goalReward };
  });
  if (!data.org || !data.branch) throw notFound();
  if (data.branch.status !== 'active' || !data.branch.slug)
    throw new BusinessError(
      409,
      'branch_inactive',
      'La sucursal está desactivada: su QR no registra clientes.',
    );

  const branding = readBranding(data.org.branding);
  const color = branding.primaryColor;
  const fg = hex(textOn(color));
  const joinUrl = printedUrls(publicBaseUrl, data.branch.slug).qrUrl;

  const pdf = await PDFDocument.create();
  pdf.setTitle(`${data.org.name} — ${data.branch.name}`);
  pdf.setCreator('Aiment Wallet');
  pdf.setProducer('Aiment Wallet');
  const page = pdf.addPage(A5);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const width = A5[0] - MARGIN * 2;
  const dark = rgb(0.07, 0.09, 0.15);
  const gray = rgb(0.42, 0.45, 0.5);

  // --- Franja de marca -------------------------------------------------------
  const bandH = 150;
  page.drawRectangle({ x: 0, y: A5[1] - bandH, width: A5[0], height: bandH, color: hex(color) });
  let logo: PDFImage | null = null;
  if (branding.logoKey) {
    const file = await storage.get(branding.logoKey);
    try {
      if (file?.contentType === 'image/png') logo = await pdf.embedPng(file.bytes);
      else if (file?.contentType === 'image/jpeg') logo = await pdf.embedJpg(file.bytes);
      // WebP no se puede incrustar en un PDF: se usa solo el nombre.
    } catch {
      logo = null;
    }
  }
  let nameTop = A5[1] - 44;
  if (logo) {
    const s = 64;
    page.drawRectangle({
      x: (A5[0] - s - 8) / 2,
      y: A5[1] - 20 - s - 8,
      width: s + 8,
      height: s + 8,
      color: rgb(1, 1, 1),
    });
    const scale = Math.min(s / logo.width, s / logo.height);
    const w = logo.width * scale;
    const h = logo.height * scale;
    page.drawImage(logo, { x: (A5[0] - w) / 2, y: A5[1] - 24 - s + (s - h) / 2, width: w, height: h });
    nameTop = A5[1] - 116;
  }
  const name = fit(bold, encodable(bold, data.org.name), logo ? 20 : 30, 12, width, logo ? 1 : 2);
  name.lines.forEach((l, i) => centered(page, bold, l, name.size, nameTop - i * (name.size + 4), fg));
  if (branding.tagline && !logo) {
    const t = fit(regular, encodable(regular, branding.tagline), 12, 9, width, 1);
    centered(page, regular, t.lines[0]!, t.size, nameTop - name.lines.length * (name.size + 4) - 6, fg);
  }

  // --- Promesa del programa ---------------------------------------------------
  let y = A5[1] - bandH - 40;
  centered(page, bold, encodable(bold, '¡Únete a nuestro programa!'), 20, y, dark);
  const promise =
    data.program?.mode === 'stamps' && data.program.goal
      ? `Junta ${data.program.goal} ${data.program.unitLabel} y gana: ${data.goalReward?.name ?? 'un premio'}`
      : `Suma ${data.program?.unitLabel ?? 'puntos'} en cada compra y canjéalos por premios`;
  const p = fit(regular, encodable(regular, promise), 14, 10, width, 2);
  y -= 26;
  for (const l of p.lines) {
    centered(page, regular, l, p.size, y, dark);
    y -= p.size + 4;
  }

  // --- QR vectorial ----------------------------------------------------------
  const qr = QRCode.create(joinUrl, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const qrSize = 200;
  const cell = qrSize / (n + 8); // 4 módulos de margen silencioso por lado
  const qrX = (A5[0] - qrSize) / 2;
  const qrTop = y - 10;
  page.drawRectangle({ x: qrX, y: qrTop - qrSize, width: qrSize, height: qrSize, color: rgb(1, 1, 1) });
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      if (qr.modules.get(r, c))
        page.drawRectangle({
          x: qrX + (c + 4) * cell,
          y: qrTop - (r + 5) * cell,
          width: cell + 0.05,
          height: cell + 0.05,
          color: rgb(0, 0, 0),
        });
  y = qrTop - qrSize - 22;
  centered(page, bold, 'Escanea con la cámara de tu celular', 13, y, dark);
  y -= 18;
  centered(page, regular, 'Sin apps ni descargas: tu tarjeta queda en tu celular', 10, y, gray);
  y -= 16;
  centered(
    page,
    regular,
    encodable(regular, joinUrl.replace(/^https?:\/\//, '').replace(/\?.*$/, '')),
    9,
    y,
    gray,
  );

  // --- Sucursal y pie ---------------------------------------------------------
  const branchLine = [data.branch.name, data.branch.address].filter(Boolean).join(' · ');
  const b = fit(regular, encodable(regular, branchLine), 10, 8, width, 1);
  centered(page, regular, b.lines[0]!, b.size, 46, gray);
  page.drawLine({
    start: { x: MARGIN, y: 36 },
    end: { x: A5[0] - MARGIN, y: 36 },
    thickness: 0.5,
    color: rgb(0.85, 0.86, 0.88),
  });
  const pw = regular.widthOfTextAtSize('Powered by ', 9);
  const aw = bold.widthOfTextAtSize('Aiment Wallet', 9);
  const px = (A5[0] - pw - aw) / 2;
  page.drawText('Powered by ', { x: px, y: 20, size: 9, font: regular, color: gray });
  page.drawText('Aiment Wallet', { x: px + pw, y: 20, size: 9, font: bold, color: dark });

  const safeBranch = data.branch.name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return {
    filename: `mostrador-${data.org.slug}-${safeBranch || 'sucursal'}.pdf`,
    bytes: await pdf.save(),
  };
}
