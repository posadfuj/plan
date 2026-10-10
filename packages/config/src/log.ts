/**
 * Logs sin tokens ni datos personales (semana 6, hardening).
 *
 * - Las rutas llevan secretos (URL de la tarjeta, recuperación, QR de caja): se reemplazan por ":token".
 * - Un error de consulta de Drizzle trae en el mensaje los parámetros SQL (celulares, correos) y
 *   Postgres agrega en `detail` la fila completa: solo se registran el código y el mensaje del motor.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Los tokens de la app son de 128 bits en base62 (~22 caracteres); los slugs y códigos cortos, de 5–6. */
const TOKEN_RE = /^[A-Za-z0-9_-]{16,}$/;

export function redactPath(path: string): string {
  return path
    .split('/')
    .map((seg) => (TOKEN_RE.test(seg) && !UUID_RE.test(seg) ? ':token' : seg))
    .join('/');
}

interface PgLike {
  code?: unknown;
  message?: unknown;
  constraint_name?: unknown;
  constraint?: unknown;
}

/** Resumen de un error apto para el log: nombre, código de Postgres y mensaje sin parámetros. */
export function safeError(err: unknown): string {
  if (!(err instanceof Error)) return 'Error no estándar';
  const parts = [err.name];
  const isQuery = err.name === 'DrizzleQueryError' || err.message.startsWith('Failed query');
  parts.push(isQuery ? 'consulta fallida (parámetros omitidos)' : firstLine(err.message));
  const cause = (err as { cause?: unknown }).cause as PgLike | undefined;
  if (cause && typeof cause === 'object') {
    if (typeof cause.code === 'string') parts.push(`pg ${cause.code}`);
    const constraint = cause.constraint_name ?? cause.constraint;
    if (typeof constraint === 'string') parts.push(`restricción ${constraint}`);
    // El mensaje del motor no lleva valores (los valores van en `detail`, que nunca se registra).
    if (typeof cause.message === 'string') parts.push(firstLine(cause.message));
  }
  // La primera línea del stack repite el mensaje (con parámetros si es una consulta): se omite.
  const frames = (err.stack ?? '')
    .split('\n')
    .filter((l) => l.trimStart().startsWith('at '))
    .slice(0, 6);
  return [parts.join(' · '), ...frames].join('\n');
}

function firstLine(s: string): string {
  return s.split('\n')[0]!.slice(0, 300);
}
