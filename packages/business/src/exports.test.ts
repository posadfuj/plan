import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { encodable } from './counter-pdf';
import { csvPhone, csvText, toCsv } from './exports';

describe('CSV seguro para Excel', () => {
  it('un texto que empieza como fórmula se neutraliza con un apóstrofo (inyección CSV)', () => {
    for (const evil of ['=HYPERLINK("http://x","clic")', '+51 1', '-2+3', '@SUM(A1)', '\tx', '\rx'])
      expect(csvText(evil).replace(/^"/, '').startsWith("'")).toBe(true);
    expect(csvText('Ana Quispe')).toBe('Ana Quispe');
  });

  it('comillas, comas y saltos de línea van entre comillas', () => {
    expect(csvText('Corte "clásico", barba')).toBe('"Corte ""clásico"", barba"');
    expect(csvText('línea 1\nlínea 2')).toBe('"línea 1\nlínea 2"');
    expect(csvText(null)).toBe('');
  });

  it('celulares de Perú en formato nacional (Excel no los toma como número ni fórmula)', () => {
    expect(csvPhone('+51987654321')).toBe('987 654 321');
    expect(csvPhone('+14155550123')).toBe("'+14155550123");
    expect(csvPhone(null)).toBe('');
  });

  it('UTF-8 con BOM y fin de línea CRLF', () => {
    const csv = toCsv(['Nombre', 'Saldo'], [['Ñusta', '3']]);
    expect(csv).toBe('\uFEFFNombre,Saldo\r\nÑusta,3\r\n');
  });
});

describe('textos del PDF de mostrador', () => {
  it('tildes, ñ, ¡ y ¿ se conservan; lo que la fuente no tiene se reemplaza sin romper el archivo', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    expect(encodable(font, '¡Únete! ¿Señor Ñandú?')).toBe('¡Únete! ¿Señor Ñandú?');
    expect(encodable(font, 'Café ☕ 咖啡')).toBe('Café ? ??');
    expect(encodable(font, '  Barbería   Pedro ')).toBe('Barbería Pedro');
  });
});
