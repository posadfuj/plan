import { describe, expect, it } from 'vitest';
import {
  addMonths,
  checkLimits,
  computeEarn,
  computeGoal,
  decideRedeem,
  decideVoid,
  isExpiredByInactivity,
  planWelcome,
  STAFF_VOID_WINDOW_MINUTES,
  toCents,
  validateAdjustment,
  type VoidInput,
} from './engine';
import { LoyaltyError } from './errors';
import { parseRule } from './rules';

const stamps = parseRule('stamps', { earnRule: { type: 'per_visit', units: 1 }, goal: 10 });
const points = parseRule('points', { earnRule: { type: 'per_amount', amount_per_unit: 1 }, goal: null });
const now = new Date('2026-10-05T15:00:00Z');
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof LoyaltyError) return e.code;
    throw e;
  }
  return undefined;
}

describe('reglas', () => {
  it('valida y completa valores por defecto', () => {
    expect(stamps).toMatchObject({
      mode: 'stamps',
      goal: 10,
      welcomeBonus: { type: 'none' },
      limits: {},
      expirationMonths: null,
    });
    expect(points.earnRule).toEqual({ type: 'per_amount', amount_per_unit: 1, rounding: 'floor' });
  });

  it('sellos exige meta; puntos no admite meta', () => {
    expect(code(() => parseRule('stamps', { earnRule: { type: 'per_visit', units: 1 }, goal: null }))).toBe(
      'invalid_rule',
    );
    expect(code(() => parseRule('points', { earnRule: { type: 'per_visit', units: 1 }, goal: 5 }))).toBe(
      'invalid_rule',
    );
  });

  it('rechaza reglas mal formadas o límites desconocidos', () => {
    expect(code(() => parseRule('stamps', { earnRule: { type: 'per_visit', units: 0 }, goal: 10 }))).toBe(
      'invalid_rule',
    );
    expect(code(() => parseRule('stamps', { earnRule: { type: 'magic' }, goal: 10 }))).toBe('invalid_rule');
    expect(
      code(() =>
        parseRule('stamps', { earnRule: { type: 'per_visit', units: 1 }, goal: 10, limits: { foo: 1 } }),
      ),
    ).toBe('invalid_rule');
    expect(
      code(() => parseRule('points', { earnRule: { type: 'per_amount', amount_per_unit: -1 }, goal: null })),
    ).toBe('invalid_rule');
  });
});

describe('montos', () => {
  it('convierte a céntimos sin errores de coma flotante', () => {
    expect(toCents('12.5')).toBe(1250);
    expect(toCents(19.99)).toBe(1999);
    expect(toCents('0.01')).toBe(1);
    expect(toCents(' 100 ')).toBe(10_000);
  });

  it('rechaza montos inválidos', () => {
    for (const bad of ['0', '-5', '1.234', 'abc', '', '1e3', 0, 0.1 + 0.2, Number.NaN])
      expect(
        code(() => toCents(bad as number | string)),
        String(bad),
      ).toBe('invalid_amount');
  });
});

describe('acumulación', () => {
  it('sellos: 1 visita = N unidades; el monto es opcional e informativo', () => {
    expect(computeEarn(stamps, {})).toEqual({ units: 1, amountCents: null });
    expect(computeEarn(stamps, { amount: '35.50' })).toEqual({ units: 1, amountCents: 3550 });
    const triple = parseRule('stamps', { earnRule: { type: 'per_visit', units: 3 }, goal: 10 });
    expect(computeEarn(triple, { amount: null }).units).toBe(3);
  });

  it('puntos: redondea hacia abajo según el monto', () => {
    expect(computeEarn(points, { amount: '25.90' })).toEqual({ units: 25, amountCents: 2590 });
    const everyTwo = parseRule('points', {
      earnRule: { type: 'per_amount', amount_per_unit: 2.5 },
      goal: null,
    });
    expect(computeEarn(everyTwo, { amount: 10 }).units).toBe(4);
    expect(computeEarn(everyTwo, { amount: '12.49' }).units).toBe(4);
  });

  it('puntos: exige monto y que alcance para al menos 1 punto', () => {
    expect(code(() => computeEarn(points, {}))).toBe('amount_required');
    expect(code(() => computeEarn(points, { amount: '' }))).toBe('amount_required');
    expect(code(() => computeEarn(points, { amount: '0.99' }))).toBe('amount_too_low');
  });
});

describe('metas con arrastre', () => {
  it('no hay premio antes de la meta', () => {
    expect(computeGoal(9, 10)).toEqual({ rewards: 0, balanceAfter: 9 });
    expect(computeGoal(50, null)).toEqual({ rewards: 0, balanceAfter: 50 });
  });

  it('al llegar a la meta gana premio y el excedente se arrastra', () => {
    expect(computeGoal(10, 10)).toEqual({ rewards: 1, balanceAfter: 0 });
    expect(computeGoal(11, 10)).toEqual({ rewards: 1, balanceAfter: 1 });
    expect(computeGoal(23, 10)).toEqual({ rewards: 2, balanceAfter: 3 });
  });
});

describe('bono de bienvenida', () => {
  it('solo en la primera visita validada', () => {
    expect(planWelcome({ type: 'units', units: 2 }, true)).toEqual({ type: 'units', units: 2 });
    expect(planWelcome({ type: 'units', units: 2 }, false)).toBeNull();
    expect(planWelcome({ type: 'none' }, true)).toBeNull();
  });
});

describe('límites', () => {
  const base = { units: 1, amountCents: null, lastEarnAt: null, actorUnitsToday: 0, now };

  it('sin límites configurados no hay violaciones', () => {
    expect(checkLimits({}, { ...base, lastEarnAt: minutesAgo(1), actorUnitsToday: 1e6 })).toEqual([]);
  });

  it('cooldown por membresía indica cuándo se puede volver a sumar', () => {
    const [v] = checkLimits({ cooldown_minutes: 240 }, { ...base, lastEarnAt: minutesAgo(60) });
    expect(v).toMatchObject({
      code: 'cooldown_active',
      retryAt: new Date(now.getTime() + 180 * 60_000).toISOString(),
    });
    expect(checkLimits({ cooldown_minutes: 240 }, { ...base, lastEarnAt: minutesAgo(241) })).toEqual([]);
  });

  it('topes por operación y por usuario al día', () => {
    const limits = { max_units_per_tx: 100, max_amount_per_tx: 500, staff_daily_units: 200 };
    const codes = checkLimits(limits, { ...base, units: 150, amountCents: 60_000, actorUnitsToday: 100 }).map(
      (v) => v.code,
    );
    expect(codes).toEqual(['max_units_per_tx', 'max_amount_per_tx', 'staff_daily_units']);
    expect(checkLimits(limits, { ...base, units: 100, amountCents: 50_000, actorUnitsToday: 100 })).toEqual(
      [],
    );
  });
});

describe('canjes', () => {
  it('premio ganado disponible: se canjea sin mover saldo', () => {
    expect(
      decideRedeem({ type: 'earned', status: 'available', expiresAt: null, rewardActive: true }, 0, now),
    ).toEqual({ delta: 0 });
  });

  it('premio ganado ya canjeado, vencido o desactivado → rechazado', () => {
    expect(
      code(() =>
        decideRedeem({ type: 'earned', status: 'redeemed', expiresAt: null, rewardActive: true }, 0, now),
      ),
    ).toBe('reward_not_available');
    expect(
      code(() =>
        decideRedeem(
          { type: 'earned', status: 'available', expiresAt: minutesAgo(1), rewardActive: true },
          0,
          now,
        ),
      ),
    ).toBe('reward_expired');
    expect(
      code(() =>
        decideRedeem({ type: 'earned', status: 'available', expiresAt: null, rewardActive: false }, 0, now),
      ),
    ).toBe('reward_inactive');
  });

  it('catálogo de puntos: descuenta el costo si alcanza el saldo', () => {
    const t = { type: 'catalog', kind: 'catalog', cost: 80, active: true } as const;
    expect(decideRedeem(t, 80, now)).toEqual({ delta: -80 });
    expect(code(() => decideRedeem(t, 79, now))).toBe('insufficient_balance');
    expect(code(() => decideRedeem({ ...t, active: false }, 100, now))).toBe('reward_inactive');
    expect(code(() => decideRedeem({ ...t, kind: 'goal', cost: null }, 100, now))).toBe(
      'reward_not_available',
    );
  });
});

describe('anulaciones', () => {
  const input = (over: Partial<VoidInput> = {}): VoidInput => ({
    entry: { kind: 'earn', delta: 1, actorId: 'staff-1', createdAt: minutesAgo(5), alreadyReversed: false },
    actor: { id: 'staff-1', canVoidAny: false, isLatestOwnEntry: true },
    sideEffects: { delta: 0, redeemedRewards: 0 },
    balance: 5,
    reason: 'Error de caja',
    now,
    ...over,
  });

  it('el trabajador anula su último movimiento dentro de la ventana', () => {
    expect(decideVoid(input())).toEqual({ reversalDelta: -1, sideEffectsReversalDelta: -0 });
  });

  it('el trabajador no anula movimientos ajenos, antiguos ni que no sean el último', () => {
    expect(
      code(() => decideVoid(input({ actor: { id: 'otro', canVoidAny: false, isLatestOwnEntry: true } }))),
    ).toBe('void_not_own');
    expect(
      code(() => decideVoid(input({ actor: { id: 'staff-1', canVoidAny: false, isLatestOwnEntry: false } }))),
    ).toBe('void_not_latest');
    expect(
      code(() =>
        decideVoid(
          input({ entry: { ...input().entry, createdAt: minutesAgo(STAFF_VOID_WINDOW_MINUTES + 1) } }),
        ),
      ),
    ).toBe('void_window_expired');
  });

  it('dueño/admin anulan cualquier movimiento, siempre con motivo', () => {
    const owner = { id: 'owner', canVoidAny: true, isLatestOwnEntry: false };
    expect(
      decideVoid(input({ actor: owner, entry: { ...input().entry, createdAt: minutesAgo(10_000) } }))
        .reversalDelta,
    ).toBe(-1);
    expect(code(() => decideVoid(input({ actor: owner, reason: ' ' })))).toBe('reason_required');
  });

  it('nunca se anula dos veces ni se anulan conversiones o reversas', () => {
    expect(code(() => decideVoid(input({ entry: { ...input().entry, alreadyReversed: true } })))).toBe(
      'already_voided',
    );
    for (const kind of ['convert', 'reversal', 'expire'])
      expect(code(() => decideVoid(input({ entry: { ...input().entry, kind } })))).toBe('not_voidable');
  });

  it('una suma que generó un premio: se revierte todo si el premio no se usó', () => {
    // Saldo 9 → +1 = 10 → premio (convert −10) → saldo 0. Anular: −1 y +10 → vuelve a 9.
    const r = decideVoid(input({ balance: 0, sideEffects: { delta: -10, redeemedRewards: 0 } }));
    expect(r).toEqual({ reversalDelta: -1, sideEffectsReversalDelta: 10 });
  });

  it('si el premio generado ya se canjeó, la anulación se bloquea', () => {
    expect(
      code(() => decideVoid(input({ balance: 0, sideEffects: { delta: -10, redeemedRewards: 1 } }))),
    ).toBe('reward_already_redeemed');
  });

  it('una visita anterior a la que completó la meta: explica que se anule primero la más reciente', () => {
    // La 10.ª visita completó la meta (convert −10) → saldo 0. Anular la 5.ª visita dejaría −1:
    // esa visita ya se consumió en el premio.
    const e = { kind: 'earn', delta: 1, actorId: 'owner', createdAt: minutesAgo(60), alreadyReversed: false };
    const owner = { id: 'owner', canVoidAny: true, isLatestOwnEntry: false };
    expect(
      code(() => decideVoid(input({ entry: e, actor: owner, balance: 0, laterGoalConversions: 1 }))),
    ).toBe('void_blocked_by_later_goal');
    // Sin conversiones posteriores, el mensaje genérico se mantiene.
    expect(code(() => decideVoid(input({ entry: e, actor: owner, balance: 0 })))).toBe(
      'balance_would_be_negative',
    );
  });

  it('no permite que el saldo quede negativo (puntos ya gastados)', () => {
    const e = { kind: 'earn', delta: 50, actorId: 'owner', createdAt: minutesAgo(5), alreadyReversed: false };
    expect(
      code(() =>
        decideVoid(
          input({ entry: e, balance: 20, actor: { id: 'owner', canVoidAny: true, isLatestOwnEntry: true } }),
        ),
      ),
    ).toBe('balance_would_be_negative');
  });

  it('anular un canje de catálogo devuelve los puntos', () => {
    const e = {
      kind: 'redeem',
      delta: -80,
      actorId: 'staff-1',
      createdAt: minutesAgo(1),
      alreadyReversed: false,
    };
    expect(decideVoid(input({ entry: e, balance: 3 })).reversalDelta).toBe(80);
  });
});

describe('ajustes manuales', () => {
  it('exigen motivo, entero distinto de cero, tope y saldo no negativo', () => {
    expect(() => validateAdjustment(5, 'Compensación por error', 0)).not.toThrow();
    expect(code(() => validateAdjustment(0, 'Compensación', 0))).toBe('invalid_adjustment');
    expect(code(() => validateAdjustment(1.5, 'Compensación', 0))).toBe('invalid_adjustment');
    expect(code(() => validateAdjustment(20_000, 'Compensación', 0))).toBe('invalid_adjustment');
    expect(code(() => validateAdjustment(5, 'no', 0))).toBe('reason_required');
    expect(code(() => validateAdjustment(-6, 'Corrección de saldo', 5))).toBe('balance_would_be_negative');
  });
});

describe('expiración por inactividad', () => {
  it('suma meses de calendario respetando fin de mes', () => {
    expect(addMonths(new Date('2026-01-31T10:00:00Z'), 1).toISOString()).toBe('2026-02-28T10:00:00.000Z');
    expect(addMonths(new Date('2028-01-31T10:00:00Z'), 1).toISOString()).toBe('2028-02-29T10:00:00.000Z');
    expect(addMonths(new Date('2026-10-05T00:00:00Z'), 12).toISOString()).toBe('2027-10-05T00:00:00.000Z');
  });

  it('vence solo si está configurado y pasó el plazo', () => {
    const last = new Date('2025-10-05T15:00:00Z');
    expect(isExpiredByInactivity(last, 12, now)).toBe(true);
    expect(isExpiredByInactivity(last, 13, now)).toBe(false);
    expect(isExpiredByInactivity(last, null, now)).toBe(false);
    expect(isExpiredByInactivity(null, 12, now)).toBe(false);
  });
});
