/**
 * Normaliza un celular a E.164. Sin prefijo se asume Perú (+51) y se exige móvil (9 dígitos que empiezan con 9).
 * Con "+" o "00" se acepta cualquier país (8–15 dígitos). Devuelve null si no es válido.
 */
export function normalizePhone(raw: string, defaultCountryCode = '51'): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 25) return null;
  if (/[^\d+\s().-]/.test(trimmed)) return null;
  let digits = trimmed.replace(/[\s().-]/g, '');
  if (digits.startsWith('00')) digits = `+${digits.slice(2)}`;
  if (digits.includes('+', 1)) return null;

  if (digits.startsWith('+')) {
    const d = digits.slice(1);
    if (!/^[1-9]\d{7,14}$/.test(d)) return null;
    if (d.startsWith('51') && !/^519\d{8}$/.test(d)) return null; // Perú: solo móviles
    return `+${d}`;
  }
  if (defaultCountryCode === '51') {
    if (/^9\d{8}$/.test(digits)) return `+51${digits}`;
    if (/^519\d{8}$/.test(digits)) return `+${digits}`;
  }
  return null;
}

/** "+51987654321" → "+51 987 *** 321": para mostrar sin exponer el número completo. */
export function maskPhone(e164: string): string {
  if (e164.length < 8) return '***';
  return `${e164.slice(0, e164.length - 9)} ${e164.slice(-9, -6)} *** ${e164.slice(-3)}`.trim();
}
