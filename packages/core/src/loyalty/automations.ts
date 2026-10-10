/**
 * Automatizaciones del MVP (semana 6, arquitectura §9): mensajes en la tarjeta del cliente.
 *
 * | Clave          | Disparo                                              |
 * | -------------- | ---------------------------------------------------- |
 * | `welcome`      | 1.ª visita validada                                  |
 * | `goal_reached` | Ganó el premio de la meta (sellos) o ya le alcanza   |
 * |                | para un premio del catálogo (puntos)                 |
 * | `almost_there` | Cruzó el umbral: le falta `threshold` o menos        |
 *
 * Núcleo puro: decide QUÉ mensajes corresponden a una operación y si un mensaje guardado sigue
 * vigente. El ledger los registra en `automation_runs` (con clave de idempotencia) y la tarjeta
 * muestra el último vigente. El bono de bienvenida en sí se configura en la regla del programa.
 */
import { z } from 'zod';
import type { ProgramMode } from './rules';

export const AUTOMATION_KEYS = ['welcome', 'goal_reached', 'almost_there'] as const;
export type AutomationKey = (typeof AUTOMATION_KEYS)[number];

export const automationConfigSchema = z
  .object({
    /** almost_there: avisar cuando falten `threshold` unidades o menos. */
    threshold: z.number().int().min(1).max(1000).optional(),
  })
  .strict();
export type AutomationConfig = z.infer<typeof automationConfigSchema>;

export interface AutomationSetting {
  enabled: boolean;
  config: AutomationConfig;
}
export type AutomationSettings = Record<AutomationKey, AutomationSetting>;

/** Sin fila en la base: activada y con la configuración por defecto. */
export function defaultAutomationSettings(): AutomationSettings {
  return {
    welcome: { enabled: true, config: {} },
    goal_reached: { enabled: true, config: {} },
    almost_there: { enabled: true, config: {} },
  };
}

/** Días que un mensaje se muestra en la tarjeta. */
export const CARD_MESSAGE_DAYS = 14;

export interface CatalogItem {
  id: string;
  name: string;
  cost: number;
}

/** Próximo premio y cuánto falta. Sellos: la meta. Puntos: el premio más barato que aún no alcanza. */
export function nextRewardFor(
  mode: ProgramMode,
  balance: number,
  goal: { goal: number | null; rewardName: string | null },
  catalog: CatalogItem[],
): { name: string; remaining: number; cost: number } | null {
  if (mode === 'stamps') {
    if (!goal.goal || !goal.rewardName) return null;
    return { name: goal.rewardName, remaining: Math.max(goal.goal - balance, 0), cost: goal.goal };
  }
  const next = [...catalog].sort((a, b) => a.cost - b.cost).find((r) => r.cost > balance);
  return next ? { name: next.name, remaining: next.cost - balance, cost: next.cost } : null;
}

/** Umbral de "te falta poco": el configurado o, por defecto, 1 sello / el 10 % del premio en puntos. */
export function almostThereThreshold(mode: ProgramMode, config: AutomationConfig, nextCost: number): number {
  if (config.threshold) return config.threshold;
  return mode === 'stamps' ? 1 : Math.max(1, Math.round(nextCost * 0.1));
}

export interface OperationFacts {
  mode: ProgramMode;
  unitLabel: string;
  goal: number | null;
  goalRewardName: string | null;
  /** Movimiento que disparó (suma o ajuste positivo). */
  entryId: string;
  balanceBefore: number;
  balanceAfter: number;
  /** true solo en la primera visita validada. */
  firstVisit: boolean;
  welcome: { type: 'none' } | { type: 'units'; units: number } | { type: 'reward'; name: string };
  /** Premios de la meta ganados en esta operación (sellos). */
  goalRewards: { earnedRewardId: string; name: string }[];
  /** Catálogo activo (puntos). */
  catalog: CatalogItem[];
}

export interface PlannedRun {
  key: AutomationKey;
  idempotencyKey: string;
  message: string;
  /** Lo necesario para saber después si el mensaje sigue vigente (sin datos personales). */
  data: Record<string, unknown>;
}

const plural = (n: number, unitLabel: string) => (n === 1 ? '1' : `${n} ${unitLabel}`);

export function planAutomations(facts: OperationFacts, settings: AutomationSettings): PlannedRun[] {
  const runs: PlannedRun[] = [];
  const base = { entryId: facts.entryId };

  if (settings.welcome.enabled && facts.firstVisit) {
    const w = facts.welcome;
    const message =
      w.type === 'units'
        ? `¡Bienvenido! Sumaste ${plural(w.units, facts.unitLabel)} de regalo por tu primera visita.`
        : w.type === 'reward'
          ? `¡Bienvenido! Tu primera visita tiene premio: ${w.name}. Pídelo en caja.`
          : `¡Gracias por tu primera visita! Ya empezaste a juntar ${facts.unitLabel}.`;
    runs.push({ key: 'welcome', idempotencyKey: `welcome:${facts.entryId}`, message, data: base });
  }

  let reachedGoal = false;
  if (facts.mode === 'stamps' && facts.goalRewards.length) {
    reachedGoal = true;
    if (settings.goal_reached.enabled) {
      const first = facts.goalRewards[0]!;
      const n = facts.goalRewards.length;
      runs.push({
        key: 'goal_reached',
        idempotencyKey: `goal_reached:${first.earnedRewardId}`,
        message:
          n === 1
            ? `¡Completaste tu tarjeta! Ganaste: ${first.name}. Muéstralo en caja para canjearlo.`
            : `¡Completaste tu tarjeta ${n} veces! Tienes ${n} premios: ${first.name}. Muéstralos en caja.`,
        data: { ...base, earnedRewardIds: facts.goalRewards.map((g) => g.earnedRewardId) },
      });
    }
  } else if (facts.mode === 'points') {
    // El premio más caro que ahora alcanza y antes no.
    const crossed = facts.catalog
      .filter((r) => r.cost > facts.balanceBefore && r.cost <= facts.balanceAfter)
      .sort((a, b) => b.cost - a.cost)[0];
    if (crossed) {
      reachedGoal = true;
      if (settings.goal_reached.enabled)
        runs.push({
          key: 'goal_reached',
          idempotencyKey: `goal_reached:${facts.entryId}:${crossed.id}`,
          message: `¡Ya te alcanza para ${crossed.name}! Pídelo en caja.`,
          data: { ...base, rewardId: crossed.id, cost: crossed.cost },
        });
    }
  }

  if (settings.almost_there.enabled && !reachedGoal) {
    const goal = { goal: facts.goal, rewardName: facts.goalRewardName };
    const after = nextRewardFor(facts.mode, facts.balanceAfter, goal, facts.catalog);
    if (after && after.remaining > 0) {
      const threshold = almostThereThreshold(facts.mode, settings.almost_there.config, after.cost);
      // "Antes" contra el MISMO premio: así solo avisa al cruzar el umbral, no en cada visita.
      const remainingBefore = after.cost - facts.balanceBefore;
      if (after.remaining <= threshold && remainingBefore > threshold)
        runs.push({
          key: 'almost_there',
          idempotencyKey: `almost_there:${facts.entryId}`,
          message:
            after.remaining === 1
              ? `¡Solo te falta 1 para ${after.name}!`
              : `¡Te faltan ${plural(after.remaining, facts.unitLabel)} para ${after.name}!`,
          data: { ...base, threshold, cost: after.cost },
        });
    }
  }
  return runs;
}

export interface StoredRun {
  key: AutomationKey;
  message: string;
  data: Record<string, unknown>;
  createdAt: Date;
}

export interface CardState {
  mode: ProgramMode;
  balance: number;
  goal: number | null;
  goalRewardName: string | null;
  catalog: CatalogItem[];
  availableEarnedRewardIds: string[];
}

/**
 * ¿Sigue vigente el último mensaje? (si el cliente ya canjeó el premio o su saldo cambió, no se
 * muestra un aviso viejo). Solo se evalúa el más reciente: uno anterior nunca reaparece.
 */
export function isCardMessageCurrent(run: StoredRun, state: CardState, now: Date): boolean {
  if (now.getTime() - run.createdAt.getTime() > CARD_MESSAGE_DAYS * 86_400_000) return false;
  switch (run.key) {
    case 'welcome':
      return true;
    case 'goal_reached': {
      if (state.mode === 'stamps') {
        const ids = Array.isArray(run.data.earnedRewardIds) ? (run.data.earnedRewardIds as string[]) : [];
        return ids.some((id) => state.availableEarnedRewardIds.includes(id));
      }
      return typeof run.data.cost === 'number' && state.balance >= run.data.cost;
    }
    case 'almost_there': {
      const next = nextRewardFor(
        state.mode,
        state.balance,
        { goal: state.goal, rewardName: state.goalRewardName },
        state.catalog,
      );
      const threshold = typeof run.data.threshold === 'number' ? run.data.threshold : 0;
      return !!next && next.remaining > 0 && next.remaining <= threshold;
    }
  }
}
