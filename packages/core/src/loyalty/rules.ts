import { z } from 'zod';
import { LoyaltyError } from './errors';

export const programModeSchema = z.enum(['stamps', 'points']);
export type ProgramMode = z.infer<typeof programModeSchema>;

export const earnRuleSchema = z.discriminatedUnion('type', [
  /** 1 visita = N unidades (barbería, lavadero). */
  z.object({ type: z.literal('per_visit'), units: z.number().int().min(1).max(100) }),
  /** Monto de compra / amount_per_unit = unidades, redondeo hacia abajo (cafetería). */
  z.object({
    type: z.literal('per_amount'),
    amount_per_unit: z.number().positive().max(10_000),
    rounding: z.literal('floor').default('floor'),
  }),
]);
export type EarnRule = z.infer<typeof earnRuleSchema>;

export const welcomeBonusSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('units'), units: z.number().int().min(1).max(100) }),
  z.object({ type: z.literal('reward'), reward_id: z.string().uuid() }),
]);
export type WelcomeBonus = z.infer<typeof welcomeBonusSchema>;

export const limitsSchema = z
  .object({
    /** Minutos mínimos entre dos sumas a la misma membresía. */
    cooldown_minutes: z.number().int().min(1).max(10_080).optional(),
    max_units_per_tx: z.number().int().min(1).max(100_000).optional(),
    max_amount_per_tx: z.number().positive().max(1_000_000).optional(),
    /** Unidades máximas que un mismo usuario puede sumar por día (zona horaria del negocio). */
    staff_daily_units: z.number().int().min(1).max(1_000_000).optional(),
  })
  .strict();
export type Limits = z.infer<typeof limitsSchema>;

export const ruleInputSchema = z.object({
  earnRule: earnRuleSchema,
  goal: z.number().int().min(1).max(1000).nullable(),
  welcomeBonus: welcomeBonusSchema.default({ type: 'none' }),
  limits: limitsSchema.default({}),
  expirationMonths: z.number().int().min(1).max(60).nullable().default(null),
});
export type RuleInput = z.input<typeof ruleInputSchema>;

export interface Rule extends z.infer<typeof ruleInputSchema> {
  id: string;
  mode: ProgramMode;
}

/**
 * Valida una versión de regla para un modo de programa.
 * Sellos: exige meta (N sellos = premio). Puntos: sin meta; se canjea contra el catálogo.
 */
export function parseRule(mode: ProgramMode, input: unknown, id = ''): Rule {
  const result = ruleInputSchema.safeParse(input);
  if (!result.success) throw new LoyaltyError('invalid_rule', { issues: result.error.issues });
  const rule = result.data;
  if (mode === 'stamps' && rule.goal === null)
    throw new LoyaltyError('invalid_rule', { field: 'goal' }, 'Un programa de sellos necesita una meta');
  if (mode === 'points' && rule.goal !== null)
    throw new LoyaltyError(
      'invalid_rule',
      { field: 'goal' },
      'Un programa de puntos usa catálogo de premios, no meta',
    );
  return { ...rule, id, mode };
}
