/**
 * Marca y datos del negocio desde el panel: nombre, color (con chequeo de contraste), logo,
 * frase, condiciones del programa y contacto.
 */
import { checkBrandColor, contrastRatio, publicBranding, readBranding, HEX_COLOR_RE } from '@aiment/core';
import { schema, withTenantTx, type Db } from '@aiment/db';
import { EMAIL_RE } from '@aiment/enrollment';
import { MAX_LOGO_BYTES, sniffImage, type ObjectStorage } from '@aiment/storage';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { BusinessError, notFound, type Editor } from './errors';
import { planUsage } from './limits';

const { organizations, auditLogs } = schema;

/** Por debajo de este contraste contra blanco los sellos prácticamente no se ven: se rechaza. */
export const MIN_ACCEPTED_CONTRAST = 1.5;

export async function getSettings(db: Db, orgId: string) {
  return withTenantTx(db, orgId, async (tx) => {
    const [org] = await tx
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        category: organizations.category,
        status: organizations.status,
        branding: organizations.branding,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    if (!org) throw notFound();
    const branding = readBranding(org.branding);
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      category: org.category,
      status: org.status,
      branding: { ...publicBranding(org.branding), hasLogo: !!branding.logoKey },
      colorCheck: checkBrandColor(branding.primaryColor),
      ...(await planUsage(tx, orgId)),
    };
  });
}

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Máximo ${max} caracteres`)
    .transform((s) => s || null)
    .nullish();

export const brandingInput = z
  .object({
    name: z
      .string()
      .trim()
      .transform((s) => s.replace(/\s+/g, ' '))
      .pipe(z.string().min(2, 'Escribe el nombre del negocio').max(60, 'Máximo 60 caracteres'))
      .optional(),
    primaryColor: z.string().regex(HEX_COLOR_RE, 'Elige un color').optional(),
    tagline: optText(80),
    conditions: optText(1000),
    contact: z
      .object({
        phone: optText(25).refine((v) => !v || /^[+0-9 ()-]{6,25}$/.test(v), 'Teléfono inválido'),
        email: optText(120).refine((v) => !v || EMAIL_RE.test(v.toLowerCase()), 'Correo inválido'),
        website: optText(200).refine((v) => !v || /^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(v), {
          message: 'La web debe empezar con https://',
        }),
        instagram: optText(60).refine((v) => !v || /^@?[A-Za-z0-9._]{1,30}$/.test(v), 'Usuario inválido'),
      })
      .strict()
      .partial()
      .optional(),
  })
  .strict();

export async function updateBranding(db: Db, orgId: string, editor: Editor, raw: unknown) {
  const input = brandingInput.parse(raw);
  if (input.primaryColor && contrastRatio(input.primaryColor, '#ffffff') < MIN_ACCEPTED_CONTRAST) {
    const check = checkBrandColor(input.primaryColor);
    throw new BusinessError(
      422,
      'color_low_contrast',
      'Ese color es muy claro: los sellos no se verían sobre el fondo blanco. Prueba con uno más oscuro.',
      { suggestion: check.suggestion },
    );
  }
  await withTenantTx(db, orgId, async (tx) => {
    const [org] = await tx
      .select({ name: organizations.name, branding: organizations.branding })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .for('update');
    if (!org) throw notFound();
    const before = readBranding(org.branding);
    const next = {
      ...(org.branding as Record<string, unknown>),
      primaryColor: input.primaryColor?.toUpperCase() ?? before.primaryColor,
      tagline: input.tagline !== undefined ? input.tagline : before.tagline,
      conditions: input.conditions !== undefined ? input.conditions : before.conditions,
      contact: {
        ...before.contact,
        ...Object.fromEntries(Object.entries(input.contact ?? {}).filter(([, v]) => v !== undefined)),
      },
      poweredBy: true,
    };
    if (next.contact.instagram) next.contact.instagram = String(next.contact.instagram).replace(/^@/, '');
    if (next.contact.email) next.contact.email = String(next.contact.email).toLowerCase();
    await tx
      .update(organizations)
      .set({ name: input.name ?? org.name, branding: next, updatedAt: new Date() })
      .where(eq(organizations.id, orgId));
    await tx.insert(auditLogs).values({
      organizationId: orgId,
      actorType: editor.actorType,
      actorId: editor.orgUserId,
      action: 'org.branding_updated',
      entityType: 'organization',
      entityId: orgId,
      before: { name: org.name, primaryColor: before.primaryColor },
      after: { name: input.name ?? org.name, primaryColor: next.primaryColor, fields: Object.keys(input) },
    });
  });
  return getSettings(db, orgId);
}

/**
 * Sube el logo. Se valida por contenido (PNG, JPEG o WebP; nunca SVG) y tamaño. Cada subida usa una
 * clave nueva: la URL pública puede guardarse en caché para siempre y cambia al cambiar el logo.
 */
export async function setLogo(
  db: Db,
  storage: ObjectStorage,
  orgId: string,
  editor: Editor,
  bytes: Uint8Array,
) {
  if (bytes.length === 0) throw new BusinessError(422, 'logo_empty', 'Elige una imagen');
  if (bytes.length > MAX_LOGO_BYTES)
    throw new BusinessError(413, 'logo_too_large', 'La imagen pesa más de 1 MB. Usa una más liviana.');
  const kind = sniffImage(bytes);
  if (!kind) throw new BusinessError(415, 'logo_type', 'El logo debe ser una imagen PNG, JPG o WebP.');
  const key = `logos/${orgId}/${randomBytes(8).toString('hex')}.${kind.ext}`;
  await storage.put(key, bytes, kind.contentType);
  await withTenantTx(db, orgId, async (tx) => {
    const [org] = await tx
      .select({ branding: organizations.branding })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .for('update');
    if (!org) throw notFound();
    await tx
      .update(organizations)
      .set({ branding: { ...(org.branding as object), logoKey: key }, updatedAt: new Date() })
      .where(eq(organizations.id, orgId));
    await tx.insert(auditLogs).values({
      organizationId: orgId,
      actorType: editor.actorType,
      actorId: editor.orgUserId,
      action: 'org.logo_updated',
      entityType: 'organization',
      entityId: orgId,
      after: { logoKey: key, bytes: bytes.length, type: kind.contentType },
    });
  });
  return getSettings(db, orgId);
}

export async function removeLogo(db: Db, orgId: string, editor: Editor) {
  await withTenantTx(db, orgId, async (tx) => {
    const [org] = await tx
      .select({ branding: organizations.branding })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .for('update');
    if (!org) throw notFound();
    const { logoKey: _k, ...rest } = org.branding as Record<string, unknown>;
    await tx
      .update(organizations)
      .set({ branding: rest, updatedAt: new Date() })
      .where(eq(organizations.id, orgId));
    await tx.insert(auditLogs).values({
      organizationId: orgId,
      actorType: editor.actorType,
      actorId: editor.orgUserId,
      action: 'org.logo_removed',
      entityType: 'organization',
      entityId: orgId,
    });
  });
  return getSettings(db, orgId);
}
