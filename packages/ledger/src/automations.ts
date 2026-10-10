/**
 * Automatizaciones (semana 6): se evalúan dentro de la MISMA transacción que la suma o el ajuste
 * (la bienvenida es síncrona por diseño y el cliente ve el mensaje apenas abre su tarjeta).
 *
 * - Corren en un savepoint: si algo falla, la suma igual se registra y queda un evento
 *   `automation.failed` en el outbox (el worker lo informa).
 * - Cada ejecución queda en `automation_runs` con una clave de idempotencia: reintentar la suma
 *   no duplica el mensaje. Al anular el movimiento que la disparó, la ejecución pasa a `voided`.
 * - Cada ejecución emite `automation.ran`: en la semana 7 el pase de Wallet mostrará el mismo mensaje.
 * - Solo en planes con la función `automations` (o con override por negocio).
 */
import {
  AUTOMATION_KEYS,
  automationConfigSchema,
  defaultAutomationSettings,
  planAutomations,
  type AutomationKey,
  type AutomationSettings,
  type OperationFacts,
  type ProgramMode,
  type WelcomeBonus,
} from '@aiment/core';
import { schema, withTenantTx, type Db, type Tx } from '@aiment/db';
import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ServiceError, type Operator } from './types';

const {
  automations,
  automationRuns,
  organizations,
  plans,
  orgFeatureOverrides,
  loyaltyPrograms,
  rewards,
  eventOutbox,
  auditLogs,
} = schema;

/** ¿El plan del negocio incluye automatizaciones? (un override por negocio manda sobre el plan). */
export async function automationsAvailable(tx: Tx, orgId: string): Promise<boolean> {
  const [override] = await tx
    .select({ value: orgFeatureOverrides.value })
    .from(orgFeatureOverrides)
    .where(
      and(eq(orgFeatureOverrides.organizationId, orgId), eq(orgFeatureOverrides.feature, 'automations')),
    );
  if (override) return override.value === true;
  const [plan] = await tx
    .select({ features: plans.features })
    .from(organizations)
    .innerJoin(plans, eq(plans.code, organizations.planCode))
    .where(eq(organizations.id, orgId));
  return (plan?.features as Record<string, unknown> | undefined)?.automations === true;
}

async function loadSettings(tx: Tx, orgId: string, programId: string): Promise<AutomationSettings> {
  const settings = defaultAutomationSettings();
  const rows = await tx
    .select({ key: automations.key, enabled: automations.enabled, config: automations.config })
    .from(automations)
    .where(and(eq(automations.organizationId, orgId), eq(automations.programId, programId)));
  for (const r of rows) {
    if (!(AUTOMATION_KEYS as readonly string[]).includes(r.key)) continue;
    const config = automationConfigSchema.safeParse(r.config);
    settings[r.key as AutomationKey] = { enabled: r.enabled, config: config.success ? config.data : {} };
  }
  return settings;
}

/** Fila de la automatización (se crea la primera vez que se usa o se configura). */
async function automationId(tx: Tx, orgId: string, programId: string, key: AutomationKey): Promise<string> {
  await tx
    .insert(automations)
    .values({ organizationId: orgId, programId, key })
    .onConflictDoNothing({ target: [automations.programId, automations.key] });
  const [row] = await tx
    .select({ id: automations.id })
    .from(automations)
    .where(and(eq(automations.programId, programId), eq(automations.key, key)));
  return row!.id;
}

export interface AutomationTrigger {
  orgId: string;
  programId: string;
  membershipId: string;
  mode: ProgramMode;
  goal: number | null;
  entryId: string;
  balanceBefore: number;
  balanceAfter: number;
  firstVisit: boolean;
  welcomeBonus: WelcomeBonus;
  goalEarnedRewardIds: string[];
  now: Date;
}

/** Evalúa y registra las automatizaciones de una operación. Nunca hace fallar la operación. */
export async function runAutomations(tx: Tx, t: AutomationTrigger): Promise<void> {
  try {
    await tx.transaction(async (sp) => {
      if (!(await automationsAvailable(sp, t.orgId))) return;
      const settings = await loadSettings(sp, t.orgId, t.programId);
      if (!AUTOMATION_KEYS.some((k) => settings[k].enabled)) return;

      const [program] = await sp
        .select({ unitLabel: loyaltyPrograms.unitLabel })
        .from(loyaltyPrograms)
        .where(eq(loyaltyPrograms.id, t.programId));
      const active = await sp
        .select({ id: rewards.id, name: rewards.name, kind: rewards.kind, cost: rewards.cost })
        .from(rewards)
        .where(
          and(
            eq(rewards.organizationId, t.orgId),
            eq(rewards.programId, t.programId),
            eq(rewards.active, true),
          ),
        )
        .orderBy(asc(rewards.sortOrder));
      const goalReward = active.find((r) => r.kind === 'goal');
      const giftName =
        t.welcomeBonus.type === 'reward'
          ? (
              await sp
                .select({ name: rewards.name })
                .from(rewards)
                .where(and(eq(rewards.id, t.welcomeBonus.reward_id), eq(rewards.organizationId, t.orgId)))
            )[0]?.name
          : undefined;

      const facts: OperationFacts = {
        mode: t.mode,
        unitLabel: program?.unitLabel ?? 'unidades',
        goal: t.goal,
        goalRewardName: goalReward?.name ?? null,
        entryId: t.entryId,
        balanceBefore: t.balanceBefore,
        balanceAfter: t.balanceAfter,
        firstVisit: t.firstVisit,
        welcome:
          t.welcomeBonus.type === 'units'
            ? { type: 'units', units: t.welcomeBonus.units }
            : t.welcomeBonus.type === 'reward' && giftName
              ? { type: 'reward', name: giftName }
              : { type: 'none' },
        goalRewards: t.goalEarnedRewardIds.map((earnedRewardId) => ({
          earnedRewardId,
          name: goalReward?.name ?? 'tu premio',
        })),
        catalog: active
          .filter((r) => r.kind === 'catalog' && r.cost !== null)
          .map((r) => ({ id: r.id, name: r.name, cost: r.cost! })),
      };

      for (const run of planAutomations(facts, settings)) {
        const [inserted] = await sp
          .insert(automationRuns)
          .values({
            organizationId: t.orgId,
            automationId: await automationId(sp, t.orgId, t.programId, run.key),
            membershipId: t.membershipId,
            idempotencyKey: `${t.orgId}:${run.idempotencyKey}`,
            status: 'done',
            result: { key: run.key, message: run.message, ...run.data },
            createdAt: t.now,
          })
          .onConflictDoNothing({ target: automationRuns.idempotencyKey })
          .returning({ id: automationRuns.id });
        if (inserted)
          await sp.insert(eventOutbox).values({
            organizationId: t.orgId,
            type: 'automation.ran',
            aggregateId: t.membershipId,
            payload: { key: run.key, runId: inserted.id },
          });
      }
    });
  } catch (err) {
    // El savepoint ya se deshizo; la suma sigue. Sin datos personales en el evento.
    await tx.insert(eventOutbox).values({
      organizationId: t.orgId,
      type: 'automation.failed',
      aggregateId: t.membershipId,
      payload: { entryId: t.entryId, error: err instanceof Error ? err.name : 'error' },
    });
  }
}

/** Al anular un movimiento, sus mensajes dejan de mostrarse. */
export async function voidAutomationRuns(tx: Tx, orgId: string, membershipId: string, entryIds: string[]) {
  if (!entryIds.length) return;
  await tx
    .update(automationRuns)
    .set({ status: 'voided' })
    .where(
      and(
        eq(automationRuns.organizationId, orgId),
        eq(automationRuns.membershipId, membershipId),
        eq(automationRuns.status, 'done'),
        inArray(sql`${automationRuns.result}->>'entryId'`, entryIds),
      ),
    );
}

// ---------------------------------------------------------------------------
// Panel: activar, desactivar y configurar
// ---------------------------------------------------------------------------
async function activeProgramId(tx: Tx, orgId: string) {
  const [p] = await tx
    .select({ id: loyaltyPrograms.id, mode: loyaltyPrograms.mode })
    .from(loyaltyPrograms)
    .where(and(eq(loyaltyPrograms.organizationId, orgId), eq(loyaltyPrograms.status, 'active')));
  if (!p) throw new ServiceError(404, 'program_not_found', 'El negocio no tiene un programa activo');
  return p;
}

async function readAutomations(tx: Tx, orgId: string, now: Date) {
  const program = await activeProgramId(tx, orgId);
  const available = await automationsAvailable(tx, orgId);
  const settings = await loadSettings(tx, orgId, program.id);
  const counts = await tx
    .select({ key: automations.key, n: sql<number>`count(*)::int` })
    .from(automationRuns)
    .innerJoin(automations, eq(automations.id, automationRuns.automationId))
    .where(
      and(
        eq(automationRuns.organizationId, orgId),
        eq(automationRuns.status, 'done'),
        gte(automationRuns.createdAt, new Date(now.getTime() - 30 * 86_400_000)),
      ),
    )
    .groupBy(automations.key);
  return {
    available,
    mode: program.mode,
    automations: AUTOMATION_KEYS.map((key) => ({
      key,
      enabled: settings[key].enabled,
      config: settings[key].config,
      runsLast30Days: counts.find((c) => c.key === key)?.n ?? 0,
    })),
  };
}

export async function listAutomations(db: Db, orgId: string, now = new Date()) {
  return withTenantTx(db, orgId, (tx) => readAutomations(tx, orgId, now));
}

const updateSchema = z
  .object({
    enabled: z.boolean().optional(),
    /** Solo almost_there. null = volver al umbral por defecto. */
    threshold: z.number().int().min(1).max(1000).nullable().optional(),
  })
  .strict();

export async function updateAutomation(db: Db, orgId: string, operator: Operator, key: string, raw: unknown) {
  if (!(AUTOMATION_KEYS as readonly string[]).includes(key))
    throw new ServiceError(404, 'not_found', 'Recurso no encontrado');
  const input = updateSchema.parse(raw ?? {});
  if (input.threshold !== undefined && key !== 'almost_there')
    throw new ServiceError(422, 'invalid_request', 'El umbral solo aplica a "Te falta poco"');
  return withTenantTx(db, orgId, async (tx) => {
    if (!(await automationsAvailable(tx, orgId)))
      throw new ServiceError(
        409,
        'plan_feature',
        'Los mensajes automáticos no están incluidos en tu plan. Para activarlos, pide a Aiment el cambio de plan.',
      );
    const program = await activeProgramId(tx, orgId);
    const k = key as AutomationKey;
    const before = (await loadSettings(tx, orgId, program.id))[k];
    const config = { ...before.config };
    if (input.threshold === null) delete config.threshold;
    else if (input.threshold !== undefined) config.threshold = input.threshold;
    const enabled = input.enabled ?? before.enabled;
    await automationId(tx, orgId, program.id, k);
    await tx
      .update(automations)
      .set({ enabled, config, updatedAt: new Date() })
      .where(and(eq(automations.programId, program.id), eq(automations.key, k)));
    await tx.insert(auditLogs).values({
      organizationId: orgId,
      actorType: operator.actorType,
      actorId: operator.orgUserId,
      action: 'automation.updated',
      entityType: 'automation',
      entityId: null,
      before: { key: k, ...before },
      after: { key: k, enabled, config },
    });
    return readAutomations(tx, orgId, new Date());
  });
}
