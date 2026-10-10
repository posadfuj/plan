/**
 * Cabeceras de seguridad de la PWA (semana 6, hardening). Una sola fuente:
 * - `vite preview` las envía (así los E2E de CI prueban la app CON la política puesta);
 * - el build genera `dist/_headers` con las mismas, para publicarla en Cloudflare (semana 9).
 * En `vite dev` no se aplican: el recargado en caliente de React usa scripts en línea.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  // wasm-unsafe-eval: el lector de QR (zxing-wasm, iPhone/Safari) compila su .wasm. Solo habilita
  // WebAssembly; `eval` de JavaScript sigue bloqueado.
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  // blob: el PNG del QR de la sucursal y la vista previa del logo antes de subirlo.
  "img-src 'self' blob: data:",
  // API, login (Supabase Auth) y archivos: todo por el mismo origen.
  "connect-src 'self'",
  "media-src 'self' blob:",
  "manifest-src 'self'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  // La caja usa la cámara; nada más del dispositivo.
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

/** Contenido de `_headers` (Cloudflare Pages / Netlify). HSTS lo agrega el borde con HTTPS. */
export function headersFile(): string {
  const lines = Object.entries(SECURITY_HEADERS).map(([k, v]) => `  ${k}: ${v}`);
  return ['/*', ...lines, '  Strict-Transport-Security: max-age=31536000; includeSubDomains', ''].join('\n');
}
