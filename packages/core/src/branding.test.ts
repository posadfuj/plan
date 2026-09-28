import { describe, expect, it } from 'vitest';
import {
  checkBrandColor,
  contrastRatio,
  darkenToContrast,
  luminance,
  publicBranding,
  readBranding,
  textOn,
} from './branding';
import { parseRule } from './loyalty/rules';
import { PROGRAM_TEMPLATES, findTemplate } from './templates';

describe('contraste de la marca', () => {
  it('calcula el contraste WCAG (negro/blanco = 21)', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
  });

  it('elige el texto con más contraste: siempre legible (≥ 4,5)', () => {
    expect(textOn('#1F2937')).toBe('#ffffff');
    expect(textOn('#FDE68A')).toBe('#000000');
    for (const hex of ['#777777', '#808080', '#00A3E0', '#FF0000', '#22C55E', '#FACC15'])
      expect(checkBrandColor(hex).textRatio).toBeGreaterThanOrEqual(4.5);
  });

  it('avisa si los sellos se verán poco sobre blanco y sugiere un tono más oscuro', () => {
    const light = checkBrandColor('#FDE68A');
    expect(light.level).toBe('low');
    expect(contrastRatio(light.suggestion!, '#ffffff')).toBeGreaterThanOrEqual(3);
    const dark = checkBrandColor('#1F2937');
    expect([dark.level, dark.suggestion]).toEqual(['ok', null]);
  });

  it('oscurecer llega al objetivo incluso desde blanco', () => {
    expect(contrastRatio(darkenToContrast('#FFFFFF', 3), '#ffffff')).toBeGreaterThanOrEqual(3);
  });

  it('un color inválido no rompe el cálculo del texto', () => {
    expect(textOn('rojo')).toBe('#ffffff');
  });
});

describe('plantillas por rubro', () => {
  it('cada plantilla es una regla válida para su modo y trae premios coherentes', () => {
    const keys = new Set<string>();
    for (const t of PROGRAM_TEMPLATES) {
      expect(keys.has(t.key)).toBe(false);
      keys.add(t.key);
      expect(() => parseRule(t.mode, t.rule)).not.toThrow();
      expect(t.rewards.length).toBeGreaterThan(0);
      for (const r of t.rewards) expect(r.kind).toBe(t.mode === 'stamps' ? 'goal' : 'catalog');
      expect(t.rule.expirationMonths).toBeNull(); // expiración desactivada en el piloto
      expect(checkBrandColor(t.primaryColor).level).toBe('ok');
    }
  });

  it('busca por clave', () => {
    expect(findTemplate('cafeteria')?.mode).toBe('points');
    expect(findTemplate('no-existe')).toBeUndefined();
  });
});

describe('marca guardada (jsonb)', () => {
  it('lee datos viejos, incompletos o basura sin lanzar', () => {
    for (const raw of [null, undefined, 'x', 42, [], {}])
      expect(readBranding(raw)).toEqual({
        primaryColor: '#1F2937',
        logoKey: null,
        tagline: null,
        conditions: null,
        contact: { phone: null, email: null, website: null, instagram: null },
      });
  });

  it('normaliza color, recorta textos y solo acepta claves de logo propias', () => {
    const b = readBranding({
      primaryColor: '#0e7490',
      logoKey: 'logos/org/abc.png',
      tagline: `  ${'x'.repeat(100)}  `,
      conditions: '   ',
      contact: { phone: ' +51 987 ', instagram: 'burbujas', email: 5 },
    });
    expect(b.primaryColor).toBe('#0E7490');
    expect(b.logoKey).toBe('logos/org/abc.png');
    expect(b.tagline).toHaveLength(80);
    expect(b.conditions).toBeNull();
    expect(b.contact).toEqual({ phone: '+51 987', email: null, website: null, instagram: 'burbujas' });
    expect(readBranding({ logoKey: '../../etc/passwd', primaryColor: 'rojo' })).toMatchObject({
      logoKey: null,
      primaryColor: '#1F2937',
    });
  });

  it('la versión pública arma la URL del logo y el color del texto', () => {
    expect(publicBranding({ primaryColor: '#FDE68A', logoKey: 'logos/o/a.png' })).toMatchObject({
      primaryColor: '#FDE68A',
      textColor: '#000000',
      logoUrl: '/v1/public/files/logos/o/a.png',
      poweredBy: true,
    });
    expect(publicBranding({}).logoUrl).toBeNull();
    expect(luminance('#FFFFFF')).toBeCloseTo(1, 5);
  });
});
