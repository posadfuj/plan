/**
 * Motor de fidelización: funciones puras, sin base de datos ni reloj propio (la hora entra como parámetro).
 * Sellos y puntos comparten el mismo ledger; solo cambia la regla que genera el delta.
 */
import { LOYALTY_ERRORS, LoyaltyError } from './errors';
import type { Limits, Rule, WelcomeBonus } from './rules';

/** Ventana para que un trabajador anule su propio último movimiento. */
export const STAFF_VOID_WINDOW_MINUTES = 15;
export const MAX_ADJUSTMENT = 10_000;

// ---------------------------------------------------------------------------
// Montos
// ---------------------------------------------------------------------------
const MONEY_RE = /^\d{1,9}(\.\d{1,2})?$/;

/** Convierte un monto (número o texto, hasta 2 decimales) a céntimos enteros, sin errores de coma flotante. */
export function toCents(amount: number | string): number {
  const text = typeof amount === 'number' ? String(amount) : amount.trim();
  if (!MONEY_RE.test(text)) throw new LoyaltyError('invalid_amount');
  const [whole, frac = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (cents <= 0) throw new LoyaltyError('invalid_amount');
  return cents;
}

// ---------------------------------------------------------------------------
// Acumulación
// ---------------------------------------------------------------------------
export interface EarnComputation {
  units: number;
  amountCents: number | null;
}

export function computeEarn(rule: Rule, input: { amount?: number | string | null }): EarnComputation {
  const r = rule.earnRule;
  if (r.type === 'per_visit') {
    const amountCents = input.amount == null || input.amount === '' ? null : toCents(input.amount);
    return { units: r.units, amountCents };
  }
  if (input.amount == null || input.amount === '') throw new LoyaltyError('amount_required');
  const amountCents = toCents(input.amount);
  const perUnitCents = Math.round(r.amount_per_unit * 100);
  const units = Math.floor(amountCents / perUnitCents);
  if (units < 1) throw new LoyaltyError('amount_too_low', { minimum: r.amount_per_unit });
  return { units, amountCents };
}

/**
 * Metas en modo sellos: cada vez que el saldo llega a la meta se gana un premio y se descuenta la meta.
 * El excedente se arrastra (meta 10, saldo 9 + 2 → 1 premio y queda 1).
 */
export function computeGoal(balance: number, goal: number | null): { rewards: number; balanceAfter: number } {
  if (!goal || balance < goal) return { rewards: 0, balanceAfter: balance };
  const rewards = Math.floor(balance / goal);
  return { rewards, balanceAfter: balance - rewards * goal };
}

/** Bono de bienvenida: solo en la primera visita validada por un trabajador. */
export function planWelcome(bonus: WelcomeBonus, isFirstValidatedVisit: boolean): WelcomeBonus | null {
  if (!isFirstValidatedVisit || bonus.type === 'none') return null;
  return bonus;
}

// ---------------------------------------------------------------------------
// Límites anti-fraude
// ---------------------------------------------------------------------------
export interface LimitContext {
  units: number;
  amountCents: number | null;
  /** Última suma (earn) de esta membresía. */
  lastEarnAt: Date | null;
  /** Unidades ya sumadas hoy por este usuario en este negocio. */
  actorUnitsToday: number;
  now: Date;
}

export interface LimitViolation {
  code: 'cooldown_active' | 'max_units_per_tx' | 'max_amount_per_tx' | 'staff_daily_units';
  message: string;
  retryAt?: string;
  limit?: number;
}

export function checkLimits(limits: Limits, ctx: LimitContext): LimitViolation[] {
  const out: LimitViolation[] = [];
  if (limits.cooldown_minutes && ctx.lastEarnAt) {
    const retryAt = new Date(ctx.lastEarnAt.getTime() + limits.cooldown_minutes * 60_000);
    if (retryAt > ctx.now)
      out.push({
        code: 'cooldown_active',
        message: LOYALTY_ERRORS.cooldown_active,
        retryAt: retryAt.toISOString(),
        limit: limits.cooldown_minutes,
      });
  }
  if (limits.max_units_per_tx && ctx.units > limits.max_units_per_tx)
    out.push({
      code: 'max_units_per_tx',
      message: LOYALTY_ERRORS.max_units_per_tx,
      limit: limits.max_units_per_tx,
    });
  if (
    limits.max_amount_per_tx &&
    ctx.amountCents !== null &&
    ctx.amountCents > Math.round(limits.max_amount_per_tx * 100)
  )
    out.push({
      code: 'max_amount_per_tx',
      message: LOYALTY_ERRORS.max_amount_per_tx,
      limit: limits.max_amount_per_tx,
    });
  if (limits.staff_daily_units && ctx.actorUnitsToday + ctx.units > limits.staff_daily_units)
    out.push({
      code: 'staff_daily_units',
      message: LOYALTY_ERRORS.staff_daily_units,
      limit: limits.staff_daily_units,
    });
  return out;
}

// ---------------------------------------------------------------------------
// Canjes
// ---------------------------------------------------------------------------
export type RedeemTarget =
  | {
      /** Premio ganado (meta de sellos, regalo de bienvenida). No mueve saldo: la meta ya se descontó. */
      type: 'earned';
      status: 'available' | 'redeemed' | 'expired' | 'voided';
      expiresAt: Date | null;
      rewardActive: boolean;
    }
  | {
      /** Premio de catálogo (puntos): descuenta su costo del saldo. */
      type: 'catalog';
      kind: 'goal' | 'catalog' | 'gift';
      cost: number | null;
      active: boolean;
    };

export function decideRedeem(target: RedeemTarget, balance: number, now: Date): { delta: number } {
  if (target.type === 'earned') {
    if (target.status !== 'available')
      throw new LoyaltyError('reward_not_available', { status: target.status });
    if (target.expiresAt && target.expiresAt <= now) throw new LoyaltyError('reward_expired');
    if (!target.rewardActive) throw new LoyaltyError('reward_inactive');
    return { delta: 0 };
  }
  if (target.kind !== 'catalog' || target.cost === null) throw new LoyaltyError('reward_not_available');
  if (!target.active) throw new LoyaltyError('reward_inactive');
  if (balance < target.cost) throw new LoyaltyError('insufficient_balance', { balance, cost: target.cost });
  return { delta: -target.cost };
}

// ---------------------------------------------------------------------------
// Anulaciones
// ---------------------------------------------------------------------------
export const VOIDABLE_KINDS = ['earn', 'bonus', 'redeem', 'adjust'] as const;

export interface VoidInput {
  entry: { kind: string; delta: number; actorId: string | null; createdAt: Date; alreadyReversed: boolean };
  actor: { id: string; canVoidAny: boolean; isLatestOwnEntry: boolean };
  /** Efectos que generó el movimiento (conversiones de meta, bono) y deben revertirse con él. */
  sideEffects: { delta: number; redeemedRewards: number };
  balance: number;
  reason: string;
  now: Date;
}

export function decideVoid(input: VoidInput): { reversalDelta: number; sideEffectsReversalDelta: number } {
  const { entry, actor } = input;
  if (input.reason.trim().length < 3) throw new LoyaltyError('reason_required');
  if (!(VOIDABLE_KINDS as readonly string[]).includes(entry.kind))
    throw new LoyaltyError('not_voidable', { kind: entry.kind });
  if (entry.alreadyReversed) throw new LoyaltyError('already_voided');
  if (!actor.canVoidAny) {
    if (entry.actorId !== actor.id) throw new LoyaltyError('void_not_own');
    if (!actor.isLatestOwnEntry) throw new LoyaltyError('void_not_latest');
    const ageMinutes = (input.now.getTime() - entry.createdAt.getTime()) / 60_000;
    if (ageMinutes > STAFF_VOID_WINDOW_MINUTES)
      throw new LoyaltyError('void_window_expired', { windowMinutes: STAFF_VOID_WINDOW_MINUTES });
  }
  if (input.sideEffects.redeemedRewards > 0) throw new LoyaltyError('reward_already_redeemed');
  const balanceAfter = input.balance - entry.delta - input.sideEffects.delta;
  if (balanceAfter < 0)
    throw new LoyaltyError('balance_would_be_negative', { balance: input.balance, balanceAfter });
  return { reversalDelta: -entry.delta, sideEffectsReversalDelta: -input.sideEffects.delta };
}

// ---------------------------------------------------------------------------
// Ajustes manuales y expiración
// ---------------------------------------------------------------------------
export function validateAdjustment(delta: number, reason: string, balance: number): void {
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > MAX_ADJUSTMENT)
    throw new LoyaltyError('invalid_adjustment', { max: MAX_ADJUSTMENT });
  if (reason.trim().length < 5) throw new LoyaltyError('reason_required');
  if (balance + delta < 0)
    throw new LoyaltyError('balance_would_be_negative', { balance, balanceAfter: balance + delta });
}

/** Suma meses de calendario (31/01 + 1 mes → 28/02 o 29/02). */
export function addMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

/** ¿Vencen los puntos por inactividad? `expirationMonths = null` → nunca (modo piloto). */
export function isExpiredByInactivity(
  lastActivityAt: Date | null,
  expirationMonths: number | null,
  now: Date,
): boolean {
  if (!expirationMonths || !lastActivityAt) return false;
  return addMonths(lastActivityAt, expirationMonths) <= now;
}
