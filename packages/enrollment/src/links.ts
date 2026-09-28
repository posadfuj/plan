/** Enlaces impresos del negocio (QR y NFC de mostrador) para el panel del dueño. */
import { schema, withTenantTx, type Db } from '@aiment/db';
import { and, asc, eq } from 'drizzle-orm';
import QRCode from 'qrcode';
import { notFound } from './errors';

const { shortLinks, branches } = schema;

/**
 * Misma URL para QR y NFC, con parámetro de canal para medir conversiones:
 * QR → /go/{slug}?c=q · NFC → /go/{slug}?c=n
 */
export function printedUrls(publicBaseUrl: string, slug: string) {
  const base = `${publicBaseUrl.replace(/\/$/, '')}/go/${slug}`;
  return { qrUrl: `${base}?c=q`, nfcUrl: `${base}?c=n` };
}

export async function listLinks(db: Db, orgId: string, publicBaseUrl: string) {
  const rows = await withTenantTx(db, orgId, (tx) =>
    tx
      .select({
        id: shortLinks.id,
        slug: shortLinks.slug,
        kind: shortLinks.kind,
        status: shortLinks.status,
        branch: branches.name,
      })
      .from(shortLinks)
      .leftJoin(branches, eq(branches.id, shortLinks.branchId))
      .where(eq(shortLinks.organizationId, orgId))
      .orderBy(asc(shortLinks.createdAt)),
  );
  return rows.map((r) => ({ ...r, ...printedUrls(publicBaseUrl, r.slug) }));
}

export async function linkQr(
  db: Db,
  orgId: string,
  linkId: string,
  publicBaseUrl: string,
  format: 'svg' | 'png',
) {
  const [link] = await withTenantTx(db, orgId, (tx) =>
    tx
      .select({ slug: shortLinks.slug })
      .from(shortLinks)
      .where(and(eq(shortLinks.id, linkId), eq(shortLinks.organizationId, orgId))),
  );
  if (!link) throw notFound();
  const { qrUrl } = printedUrls(publicBaseUrl, link.slug);
  const opts = { margin: 2, errorCorrectionLevel: 'M' as const };
  return format === 'svg'
    ? { contentType: 'image/svg+xml', body: await QRCode.toString(qrUrl, { ...opts, type: 'svg' }) }
    : { contentType: 'image/png', body: await QRCode.toBuffer(qrUrl, { ...opts, type: 'png', width: 1024 }) };
}
