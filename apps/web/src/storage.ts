/**
 * Recuerda en ESTE navegador qué tarjeta tiene el cliente en cada negocio (para "Abrir mi tarjeta").
 * Puede no estar disponible (modo privado): todo funciona igual sin esto.
 */
const KEY = 'aiment.cards.v1';

function read(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

export function rememberCard(orgId: string, token: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...read(), [orgId]: token }));
  } catch {
    /* sin almacenamiento */
  }
}

export function savedCard(orgId: string): string | null {
  return read()[orgId] ?? null;
}

export function forgetCard(orgId: string) {
  try {
    const all = read();
    delete all[orgId];
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* sin almacenamiento */
  }
}
