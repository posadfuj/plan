/**
 * Marca del negocio: validación de colores y chequeo de contraste (WCAG 2.1).
 * Puro: lo usan la API (valida) y la PWA (vista previa y avisos) con la misma regla.
 */
export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
export const DEFAULT_BRAND_COLOR = '#1F2937';

/** Contraste mínimo del color de marca contra el fondo blanco de la tarjeta (sellos, barra de progreso). */
export const MIN_GRAPHIC_CONTRAST = 3;

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** Luminancia relativa (0 = negro, 1 = blanco). */
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Texto blanco o negro (el negro puro garantiza ≥ 4,5 en tonos medios), el que más contraste tenga sobre el color de marca. */
export function textOn(hex: string): '#ffffff' | '#000000' {
  if (!HEX_COLOR_RE.test(hex)) return '#ffffff';
  return contrastRatio(hex, '#ffffff') >= contrastRatio(hex, '#000000') ? '#ffffff' : '#000000';
}

export interface ColorCheck {
  /** Color del texto que irá sobre el encabezado. */
  text: '#ffffff' | '#000000';
  /** Contraste del texto del encabezado (siempre ≥ 4,5 eligiendo blanco o negro). */
  textRatio: number;
  /** Contraste del color contra el fondo blanco (sellos y barra de progreso). */
  onWhiteRatio: number;
  /** ok = se ve bien · low = los sellos se verán poco sobre blanco (se sugiere uno más oscuro). */
  level: 'ok' | 'low';
  suggestion: string | null;
}

export function checkBrandColor(hex: string): ColorCheck {
  const text = textOn(hex);
  const onWhiteRatio = contrastRatio(hex, '#ffffff');
  const low = onWhiteRatio < MIN_GRAPHIC_CONTRAST;
  return {
    text,
    textRatio: contrastRatio(hex, text),
    onWhiteRatio,
    level: low ? 'low' : 'ok',
    suggestion: low ? darkenToContrast(hex, MIN_GRAPHIC_CONTRAST) : null,
  };
}

/** Oscurece el color (mismo tono) hasta alcanzar el contraste pedido contra blanco. */
export function darkenToContrast(hex: string, target: number): string {
  const n = parseInt(hex.slice(1), 16);
  let [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  for (let i = 0; i < 100; i++) {
    const out = `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
    if (contrastRatio(out, '#ffffff') >= target) return out;
    [r, g, b] = [r, g, b].map((c) => Math.floor(c * 0.95)) as [number, number, number];
  }
  return '#000000';
}

// ---------------------------------------------------------------------------
// Datos de marca guardados en organizations.branding (jsonb)
// ---------------------------------------------------------------------------
export interface BrandContact {
  phone: string | null;
  email: string | null;
  website: string | null;
  instagram: string | null;
}

export interface Branding {
  primaryColor: string;
  /** Clave del logo en el almacenamiento de archivos (se sirve en /v1/public/files/{clave}). */
  logoKey: string | null;
  /** Frase corta bajo el nombre del negocio. */
  tagline: string | null;
  /** Condiciones del programa (se muestran en la tarjeta y en el registro). */
  conditions: string | null;
  contact: BrandContact;
}

const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** Lee la marca guardada tolerando datos viejos o incompletos (nunca lanza). */
export function readBranding(raw: unknown): Branding {
  const b = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const c = b.contact && typeof b.contact === 'object' ? (b.contact as Record<string, unknown>) : {};
  return {
    primaryColor:
      typeof b.primaryColor === 'string' && HEX_COLOR_RE.test(b.primaryColor)
        ? b.primaryColor.toUpperCase()
        : DEFAULT_BRAND_COLOR,
    logoKey: typeof b.logoKey === 'string' && /^logos\//.test(b.logoKey) ? b.logoKey : null,
    tagline: str(b.tagline, 80),
    conditions: str(b.conditions, 1000),
    contact: {
      phone: str(c.phone, 25),
      email: str(c.email, 120),
      website: str(c.website, 200),
      instagram: str(c.instagram, 60),
    },
  };
}

export const publicFilePath = (key: string) => `/v1/public/files/${key}`;

/** Lo que ven el cliente (registro y tarjeta) y la vista previa del panel. */
export function publicBranding(raw: unknown) {
  const b = readBranding(raw);
  return {
    primaryColor: b.primaryColor,
    textColor: textOn(b.primaryColor),
    logoUrl: b.logoKey ? publicFilePath(b.logoKey) : null,
    tagline: b.tagline,
    conditions: b.conditions,
    contact: b.contact,
    poweredBy: true as const,
  };
}
export type PublicBranding = ReturnType<typeof publicBranding>;
