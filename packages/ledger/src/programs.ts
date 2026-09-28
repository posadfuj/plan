/**
 * Configuración del programa: versiones de regla y premios.
 * Cambiar una regla crea una versión nueva; los movimientos anteriores conservan la suya.
 */
import { LoyaltyError, findTemplate, parseRule, type RuleInput } from '@aiment/core';
import { schema, withTenantTx, type Db, type Tx } from '@aiment/db';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ServiceError, type Operator } from './types';

const { loyaltyPrograms, programRuleVersions, rewards, memberships, auditLogs, eventOutbox } = schema;
type RewardKind = (typeof schema.rewardKind.enumValues)[number];

const notFound = () => new ServiceError(404, 'not_found', 'Recurso no encontrado');

async function activeProgram(tx: Tx, orgId: string, lock = false) {
  const q = tx
    .select()
    .from(loyaltyPrograms)
    .where(and(eq(loyaltyPrograms.organizationId, orgId), eq(loyaltyPrograms.status, 'active')));
  const [p] = lock ? await q.for('update') : await q;
  if (!p) throw new ServiceError(404, 'program_not_found', 'El negocio no tiene un programa activo');
  return p;
}

export async function getProgram(db: Db, orgId: string) {
  return withTenantTx(db, orgId, async (tx) => {
    const program = await activeProgram(tx, orgId);
    const [rule] = await tx
      .select()
      .from(programRuleVersions)
      .where(eq(programRuleVersions.id, program.currentVersionId!));
    const list = await tx
      .select()
      .from(rewards)
      .where(and(eq(rewards.organizationId, orgId), eq(rewards.programId, program.id)))
      .orderBy(asc(rewards.sortOrder), asc(rewards.createdAt));
    const [{ members }] = (await tx
      .select({ members: sql<number>`count(*)::int` })
      .from(memberships)
      .where(eq(memberships.programId, program.id))) as [{ members: number }];
    return {
      id: program.id,
      /** Con clientes no se puede cambiar de plantilla (sellos ↔ puntos). */
      members,
      name: program.name,
      mode: program.mode,
      unitLabel: program.unitLabel,
      rule: rule
        ? {
            id: rule.id,
            version: rule.version,
            earnRule: rule.earnRule,
            goal: rule.goal,
            welcomeBonus: rule.welcomeBonus,
            limits: rule.limits,
            expirationMonths: rule.expirationMonths,
            createdAt: rule.createdAt,
          }
        : null,
      rewards: list.map((r) => ({
        id: r.id,
        kind: r.kind,
        name: r.name,
        description: r.description,
        cost: r.cost,
        validityDays: r.validityDays,
        active: r.active,
        sortOrder: r.sortOrder,
      })),
    };
  });
}

async function assertGiftReward(tx: Tx, orgId: string, programId: string, rewardId: string) {
  const [gift] = await tx
    .select({ id: rewards.id })
    .from(rewards)
    .where(
      and(
        eq(rewards.id, rewardId),
        eq(rewards.organizationId, orgId),
        eq(rewards.programId, programId),
        eq(rewards.kind, 'gift'),
        eq(rewards.active, true),
      ),
    );
  if (!gift)
    throw new LoyaltyError(
      'invalid_rule',
      { field: 'welcomeBonus' },
      'El regalo de bienvenida debe ser un premio de tipo regalo activo',
    );
}

/** Publica una nueva versión de la regla del programa (el modo sellos/puntos no cambia). */
export async function createRuleVersion(db: Db, orgId: string, operator: Operator, input: RuleInput) {
  return withTenantTx(db, orgId, async (tx) => {
    const program = await activeProgram(tx, orgId, true);
    const rule = parseRule(program.mode, input);
    if (rule.welcomeBonus.type === 'reward')
      await assertGiftReward(tx, orgId, program.id, rule.welcomeBonus.reward_id);

    const [prev] = await tx
      .select()
      .from(programRuleVersions)
      .where(eq(programRuleVersions.id, program.currentVersionId!));
    const [{ next }] = (await tx
      .select({ next: sql<number>`coalesce(max(${programRuleVersions.version}), 0)::int + 1` })
      .from(programRuleVersions)
      .where(eq(programRuleVersions.programId, program.id))) as [{ next: number }];
    const [created] = await tx
      .insert(programRuleVersions)
      .values({
        organizationId: orgId,
        programId: program.id,
        version: next,
        earnRule: rule.earnRule,
        goal: rule.goal,
        welcomeBonus: rule.welcomeBonus,
        limits: rule.limits,
        expirationMonths: rule.expirationMonths,
        createdBy: operator.orgUserId,
      })
      .returning();
    await tx
      .update(loyaltyPrograms)
      .set({ currentVersionId: created!.id })
      .where(eq(loyaltyPrograms.id, program.id));
    await tx.insert(auditLogs).values({
      organizationId: orgId,
      actorType: operator.actorType,
      actorId: operator.orgUserId,
      action: 'program.rule_changed',
      entityType: 'program_rule_version',
      entityId: created!.id,
      before: prev
        ? { version: prev.version, earnRule: prev.earnRule, goal: prev.goal, limits: prev.limits }
        : null,
      after: { version: created!.version, earnRule: rule.earnRule, goal: rule.goal, limits: rule.limits },
    });
    // Cambia lo que muestran los pases de todo el programa (p. ej. la meta): lo consumirá la semana 7.
    await tx.insert(eventOutbox).values({
      organizationId: orgId,
      type: 'program.updated',
      aggregateId: program.id,
      payload: { version: next },
    });
    return { id: created!.id, version: created!.version };
  });
}

export interface RewardInput {
  kind: RewardKind;
  name: string;
  description?: string | null;
  cost?: number | null;
  validityDays?: number | null;
  active?: boolean;
  sortOrder?: number;
}

function validateReward(mode: 'stamps' | 'points', r: RewardInput) {
  const bad = (message: string) => new LoyaltyError('invalid_rule', { field: 'reward' }, message);
  if (!r.name?.trim() || r.name.trim().length > 80)
    throw bad('El nombre del premio es obligatorio (máx. 80 caracteres)');
  if (r.kind === 'goal' && mode !== 'stamps')
    throw bad('El premio de meta solo existe en programas de sellos');
  if (r.kind === 'catalog' && mode !== 'points')
    throw bad('El catálogo de premios solo existe en programas de puntos');
  if (r.kind === 'catalog' && !(Number.isInteger(r.cost) && r.cost! > 0))
    throw bad('Un premio de catálogo necesita un costo en puntos');
  if (r.kind !== 'catalog' && r.cost != null) throw bad('Solo los premios de catálogo tienen costo');
  if (
    r.validityDays != null &&
    !(Number.isInteger(r.validityDays) && r.validityDays > 0 && r.validityDays <= 730)
  )
    throw bad('La vigencia debe estar entre 1 y 730 días');
}

async function assertSingleActiveGoal(tx: Tx, orgId: string, programId: string, exceptId?: string) {
  const [other] = await tx
    .select({ id: rewards.id })
    .from(rewards)
    .where(
      and(
        eq(rewards.organizationId, orgId),
        eq(rewards.programId, programId),
        eq(rewards.kind, 'goal'),
        eq(rewards.active, true),
        exceptId ? ne(rewards.id, exceptId) : undefined,
      ),
    );
  if (other)
    throw new LoyaltyError(
      'invalid_rule',
      { field: 'reward' },
      'Ya hay un premio de meta activo; desactívalo antes de crear otro',
    );
}

export async function createReward(db: Db, orgId: string, operator: Operator, input: RewardInput) {
  return withTenantTx(db, orgId, async (tx) => {
    const program = await activeProgram(tx, orgId, true);
    validateReward(program.mode, input);
    if (input.kind === 'goal' && input.active !== false) await assertSingleActiveGoal(tx, orgId, program.id);
    const [r] = await tx
      .insert(rewards)
      .values({
        organizationId: orgId,
        programId: program.id,
        kind: input.kind,
        name: input.name.trim(),
        description: input.description?.trim() || null,
        cost: input.kind === 'catalog' ? input.cost! : null,
        validityDays: input.validityDays ?? null,
        active: input.active ?? true,
        sortOrder: input.sortOrder ?? 0,
      })
      .returning();
    await tx.insert(auditLogs).values({
      organizationId: orgId,
      actorType: operator.actorType,
      actorId: operator.orgUserId,
      action: 'reward.created',
      entityType: 'reward',
      entityId: r!.id,
      after: { kind: r!.kind, name: r!.name, cost: r!.cost },
    });
    return r!;
  });
}

export async function updateReward(
  db: Db,
  orgId: string,
  operator: Operator,
  rewardId: string,
  patch: Partial<Omit<RewardInput, 'kind'>>,
) {
  return withTenantTx(db, orgId, async (tx) => {
    const program = await activeProgram(tx, orgId, true);
    const [current] = await tx
      .select()
      .from(rewards)
      .where(
        and(eq(rewards.id, rewardId), eq(rewards.organizationId, orgId), eq(rewards.programId, program.id)),
      )
      .for('update');
    if (!current) throw notFound();
    const merged: RewardInput = {
      kind: current.kind,
      name: patch.name ?? current.name,
      description: patch.description !== undefined ? patch.description : current.description,
      cost: patch.cost !== undefined ? patch.cost : current.cost,
      validityDays: patch.validityDays !== undefined ? patch.validityDays : current.validityDays,
      active: patch.active ?? current.active,
      sortOrder: patch.sortOrder ?? current.sortOrder,
    };
    validateReward(program.mode, merged);
    if (merged.kind === 'goal' && merged.active)
      await assertSingleActiveGoal(tx, orgId, program.id, current.id);
    const [r] = await tx
      .update(rewards)
      .set({
        name: merged.name.trim(),
        description: merged.description?.trim() || null,
        cost: merged.kind === 'catalog' ? merged.cost! : null,
        validityDays: merged.validityDays ?? null,
        active: merged.active,
        sortOrder: merged.sortOrder,
      })
      .where(eq(rewards.id, current.id))
      .returning();
    await tx.insert(auditLogs).values({
      organizationId: orgId,
      actorType: operator.actorType,
      actorId: operator.orgUserId,
      action: 'reward.updated',
      entityType: 'reward',
      entityId: current.id,
      before: {
        name: current.name,
        cost: current.cost,
        active: current.active,
        validityDays: current.validityDays,
      },
      after: { name: r!.name, cost: r!.cost, active: r!.active, validityDays: r!.validityDays },
    });
    return r!;
  });
}

const programPatch = z
  .object({
    name: z
      .string()
      .trim()
      .transform((s) => s.replace(/\s+/g, ' '))
      .pipe(z.string().min(2, 'Escribe el nombre del programa').max(60, 'Máximo 60 caracteres'))
      .optional(),
    unitLabel: z
      .string()
      .trim()
      .toLowerCase()
      .pipe(z.string().regex(/^[\p{L} ]{3,20}$/u, 'Usa una palabra en plural, p. ej. "sellos" o "puntos"'))
      .optional(),
  })
  .strict();

/** Nombre del programa y cómo se llaman las unidades ("sellos", "puntos", "cafecitos"…). */
export async function updateProgram(db: Db, orgId: string, operator: Operator, raw: unknown) {
  const patch = programPatch.parse(raw);
  return withTenantTx(db, orgId, async (tx) => {
    const program = await activeProgram(tx, orgId, true);
    await tx
      .update(loyaltyPrograms)
      .set({ name: patch.name ?? program.name, unitLabel: patch.unitLabel ?? program.unitLabel })
      .where(eq(loyaltyPrograms.id, program.id));
    await tx.insert(auditLogs).values({
      organizationId: orgId,
      actorType: operator.actorType,
      actorId: operator.orgUserId,
      action: 'program.updated',
      entityType: 'loyalty_program',
      entityId: program.id,
      before: { name: program.name, unitLabel: program.unitLabel },
      after: { name: patch.name ?? program.name, unitLabel: patch.unitLabel ?? program.unitLabel },
    });
    await tx.insert(eventOutbox).values({
      organizationId: orgId,
      type: 'program.updated',
      aggregateId: program.id,
      payload: { fields: Object.keys(patch) },
    });
    return { id: program.id };
  });
}

/**
 * Aplica una plantilla por rubro (puede cambiar sellos ↔ puntos). Solo mientras el programa no tenga
 * clientes: con clientes, cambiar el modo alteraría saldos ya ganados. Los premios anteriores quedan
 * desactivados (no se borran) y se crea una versión de regla nueva.
 */
export async function applyTemplate(db: Db, orgId: string, operator: Operator, templateKey: unknown) {
  const t = findTemplate(templateKey);
  if (!t) throw new LoyaltyError('invalid_rule', { field: 'template' }, 'Elige una plantilla');
  return withTenantTx(db, orgId, async (tx) => {
    const program = await activeProgram(tx, orgId, true);
    const [{ n }] = (await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(memberships)
      .where(eq(memberships.programId, program.id))) as [{ n: number }];
    if (n > 0)
      throw new ServiceError(
        409,
        'program_in_use',
        'El programa ya tiene clientes: edita la regla y los premios en lugar de cambiar de plantilla',
      );
    const rule = parseRule(t.mode, t.rule);
    await tx
      .update(rewards)
      .set({ active: false })
      .where(and(eq(rewards.programId, program.id), eq(rewards.organizationId, orgId)));
    for (const [i, r] of t.rewards.entries())
      await tx.insert(rewards).values({
        organizationId: orgId,
        programId: program.id,
        kind: r.kind,
        name: r.name,
        cost: r.kind === 'catalog' ? r.cost! : null,
        validityDays: r.validityDays ?? null,
        sortOrder: i,
      });
    const [{ next }] = (await tx
      .select({ next: sql<number>`coalesce(max(${programRuleVersions.version}), 0)::int + 1` })
      .from(programRuleVersions)
      .where(eq(programRuleVersions.programId, program.id))) as [{ next: number }];
    const [created] = await tx
      .insert(programRuleVersions)
      .values({
        organizationId: orgId,
        programId: program.id,
        version: next,
        earnRule: rule.earnRule,
        goal: rule.goal,
        welcomeBonus: rule.welcomeBonus,
        limits: rule.limits,
        expirationMonths: rule.expirationMonths,
        createdBy: operator.orgUserId,
      })
      .returning({ id: programRuleVersions.id });
    await tx
      .update(loyaltyPrograms)
      .set({ mode: t.mode, unitLabel: t.unitLabel, currentVersionId: created!.id })
      .where(eq(loyaltyPrograms.id, program.id));
    await tx.insert(auditLogs).values({
      organizationId: orgId,
      actorType: operator.actorType,
      actorId: operator.orgUserId,
      action: 'program.template_applied',
      entityType: 'loyalty_program',
      entityId: program.id,
      before: { mode: program.mode },
      after: { template: t.key, mode: t.mode, version: next },
    });
    return { id: program.id, template: t.key, version: next };
  });
}
