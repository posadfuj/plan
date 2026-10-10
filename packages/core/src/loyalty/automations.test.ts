import { describe, expect, it } from 'vitest';
import {
  almostThereThreshold,
  automationConfigSchema,
  defaultAutomationSettings,
  isCardMessageCurrent,
  nextRewardFor,
  planAutomations,
  type CardState,
  type OperationFacts,
} from './automations';

const now = new Date('2026-10-10T15:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
const on = defaultAutomationSettings;
const off = (key: 'welcome' | 'goal_reached' | 'almost_there') => {
  const s = on();
  s[key] = { enabled: false, config: {} };
  return s;
};

const stamps = (over: Partial<OperationFacts> = {}): OperationFacts => ({
  mode: 'stamps',
  unitLabel: 'sellos',
  goal: 10,
  goalRewardName: 'Corte gratis',
  entryId: 'e1',
  balanceBefore: 3,
  balanceAfter: 4,
  firstVisit: false,
  welcome: { type: 'none' },
  goalRewards: [],
  catalog: [],
  ...over,
});

const catalog = [
  { id: 'r-cafe', name: 'Café gratis', cost: 100 },
  { id: 'r-torta', name: 'Torta', cost: 300 },
];
const points = (over: Partial<OperationFacts> = {}): OperationFacts => ({
  ...stamps(),
  mode: 'points',
  unitLabel: 'puntos',
  goal: null,
  goalRewardName: null,
  catalog,
  ...over,
});

const keys = (f: OperationFacts, s = on()) => planAutomations(f, s).map((r) => r.key);

describe('bienvenida', () => {
  it('solo en la primera visita, con el texto según el bono de la regla', () => {
    expect(keys(stamps())).toEqual([]);
    const [units] = planAutomations(stamps({ firstVisit: true, welcome: { type: 'units', units: 2 } }), on());
    expect(units).toMatchObject({ key: 'welcome', idempotencyKey: 'welcome:e1' });
    expect(units!.message).toContain('Sumaste 2 sellos de regalo');
    const [one] = planAutomations(stamps({ firstVisit: true, welcome: { type: 'units', units: 1 } }), on());
    expect(one!.message).toContain('Sumaste 1 de regalo');
    const [gift] = planAutomations(
      stamps({ firstVisit: true, welcome: { type: 'reward', name: 'Café' } }),
      on(),
    );
    expect(gift!.message).toContain('Tu primera visita tiene premio: Café');
    const [none] = planAutomations(stamps({ firstVisit: true }), on());
    expect(none!.message).toContain('Gracias por tu primera visita');
  });

  it('desactivada: no hay mensaje', () => {
    expect(keys(stamps({ firstVisit: true }), off('welcome'))).toEqual([]);
  });
});

describe('meta alcanzada', () => {
  it('sellos: un mensaje por operación aunque gane varios premios, y no avisa "te falta poco"', () => {
    const one = planAutomations(
      stamps({
        balanceBefore: 9,
        balanceAfter: 0,
        goalRewards: [{ earnedRewardId: 'g1', name: 'Corte gratis' }],
      }),
      on(),
    );
    expect(one).toEqual([
      expect.objectContaining({
        key: 'goal_reached',
        idempotencyKey: 'goal_reached:g1',
        data: { entryId: 'e1', earnedRewardIds: ['g1'] },
      }),
    ]);
    expect(one[0]!.message).toContain('¡Completaste tu tarjeta! Ganaste: Corte gratis');
    const two = planAutomations(
      stamps({
        goalRewards: [
          { earnedRewardId: 'g1', name: 'Corte gratis' },
          { earnedRewardId: 'g2', name: 'Corte gratis' },
        ],
      }),
      on(),
    );
    expect(two[0]!.message).toContain('2 veces');
  });

  it('sellos con la meta desactivada: tampoco avisa "te falta poco" en esa operación', () => {
    const facts = stamps({
      balanceBefore: 9,
      balanceAfter: 0,
      goalRewards: [{ earnedRewardId: 'g1', name: 'X' }],
    });
    expect(keys(facts, off('goal_reached'))).toEqual([]);
  });

  it('puntos: avisa el premio más caro que ahora alcanza (y antes no)', () => {
    const [r] = planAutomations(points({ balanceBefore: 80, balanceAfter: 320 }), on());
    expect(r).toMatchObject({
      key: 'goal_reached',
      idempotencyKey: 'goal_reached:e1:r-torta',
      data: { rewardId: 'r-torta', cost: 300 },
    });
    expect(keys(points({ balanceBefore: 120, balanceAfter: 150 }))).toEqual([]); // ya alcanzaba el café
    expect(keys(points({ balanceBefore: 80, balanceAfter: 320 }), off('goal_reached'))).toEqual([]);
  });
});

describe('te falta poco', () => {
  it('sellos: avisa solo al cruzar el umbral (por defecto, falta 1)', () => {
    const [r] = planAutomations(stamps({ balanceBefore: 8, balanceAfter: 9 }), on());
    expect(r).toMatchObject({
      key: 'almost_there',
      idempotencyKey: 'almost_there:e1',
      data: { threshold: 1 },
    });
    expect(r!.message).toBe('¡Solo te falta 1 para Corte gratis!');
    expect(keys(stamps({ balanceBefore: 9, balanceAfter: 9 }))).toEqual([]); // ya estaba en el umbral
    expect(keys(stamps({ balanceBefore: 3, balanceAfter: 4 }))).toEqual([]);
  });

  it('umbral configurado y texto en plural', () => {
    const s = on();
    s.almost_there.config = { threshold: 3 };
    const [r] = planAutomations(stamps({ balanceBefore: 5, balanceAfter: 7 }), s);
    expect(r!.message).toBe('¡Te faltan 3 sellos para Corte gratis!');
    expect(keys(stamps({ balanceBefore: 5, balanceAfter: 7 }), off('almost_there'))).toEqual([]);
  });

  it('puntos: por defecto el 10 % del próximo premio', () => {
    const [r] = planAutomations(points({ balanceBefore: 80, balanceAfter: 95 }), on());
    expect(r).toMatchObject({ key: 'almost_there', data: { threshold: 10, cost: 100 } });
    expect(r!.message).toBe('¡Te faltan 5 puntos para Café gratis!');
    expect(keys(points({ balanceBefore: 300, balanceAfter: 350 }))).toEqual([]); // ya no hay próximo premio
  });

  it('sin premio de meta configurado no hay próximo premio', () => {
    expect(keys(stamps({ goalRewardName: null, balanceBefore: 8, balanceAfter: 9 }))).toEqual([]);
  });
});

describe('utilidades', () => {
  it('próximo premio y umbral', () => {
    expect(nextRewardFor('stamps', 12, { goal: 10, rewardName: 'X' }, [])).toEqual({
      name: 'X',
      remaining: 0,
      cost: 10,
    });
    expect(nextRewardFor('stamps', 1, { goal: null, rewardName: 'X' }, [])).toBeNull();
    expect(nextRewardFor('points', 150, { goal: null, rewardName: null }, catalog)).toMatchObject({
      name: 'Torta',
      remaining: 150,
    });
    expect(almostThereThreshold('points', {}, 4)).toBe(1);
    expect(almostThereThreshold('stamps', { threshold: 2 }, 10)).toBe(2);
  });

  it('configuración: solo un umbral entero entre 1 y 1000', () => {
    expect(automationConfigSchema.safeParse({ threshold: 2 }).success).toBe(true);
    expect(automationConfigSchema.safeParse({ threshold: 0 }).success).toBe(false);
    expect(automationConfigSchema.safeParse({ otro: 1 }).success).toBe(false);
  });
});

describe('mensaje vigente en la tarjeta', () => {
  const card = (over: Partial<CardState> = {}): CardState => ({
    mode: 'stamps',
    balance: 9,
    goal: 10,
    goalRewardName: 'Corte gratis',
    catalog: [],
    availableEarnedRewardIds: [],
    ...over,
  });
  const run = (key: 'welcome' | 'goal_reached' | 'almost_there', data: Record<string, unknown>, age = 1) => ({
    key,
    message: 'm',
    data,
    createdAt: daysAgo(age),
  });

  it('vence a los 14 días', () => {
    expect(isCardMessageCurrent(run('welcome', {}, 13), card(), now)).toBe(true);
    expect(isCardMessageCurrent(run('welcome', {}, 15), card(), now)).toBe(false);
  });

  it('premio de la meta: solo mientras no se haya canjeado', () => {
    const r = run('goal_reached', { earnedRewardIds: ['g1'] });
    expect(isCardMessageCurrent(r, card({ availableEarnedRewardIds: ['g1'] }), now)).toBe(true);
    expect(isCardMessageCurrent(r, card(), now)).toBe(false);
    expect(isCardMessageCurrent(run('goal_reached', {}), card(), now)).toBe(false);
  });

  it('puntos: mientras el saldo alcance', () => {
    const r = run('goal_reached', { cost: 100 });
    expect(isCardMessageCurrent(r, card({ mode: 'points', balance: 120, catalog }), now)).toBe(true);
    expect(isCardMessageCurrent(r, card({ mode: 'points', balance: 20, catalog }), now)).toBe(false);
  });

  it('te falta poco: mientras siga faltando poco', () => {
    const r = run('almost_there', { threshold: 1 });
    expect(isCardMessageCurrent(r, card({ balance: 9 }), now)).toBe(true);
    expect(isCardMessageCurrent(r, card({ balance: 4 }), now)).toBe(false); // anularon o canjeó
    expect(isCardMessageCurrent(r, card({ balance: 10 }), now)).toBe(false);
    expect(isCardMessageCurrent(run('almost_there', {}), card(), now)).toBe(false);
  });
});
