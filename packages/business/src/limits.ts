/**
 * Límites del plan (plans.limits): sucursales activas y trabajadores de caja activos.
 * Se validan dentro de la misma transacción que crea el recurso, con la organización bloqueada,
 * para que dos altas simultáneas no pasen el tope.
 */
import { schema, type Tx } from '@aiment/db';
import { and, eq, sql } from 'drizzle-orm';
import { BusinessError } from './errors';

const { organizations, plans, branches, organizationUsers } = schema;

export type LimitKey = 'branches' | 'staff';
const LABEL: Record<LimitKey, [string, string]> = {
  branches: ['sucursal', 'sucursales'],
  staff: ['trabajador de caja', 'trabajadores de caja'],
};

export async function planUsage(tx: Tx, orgId: string, lock = false) {
  // Bloquear la fila del negocio serializa las altas simultáneas (dos altas no pasan el tope a la vez).
  if (lock)
    await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .for('update');
  const [plan] = await tx
    .select({ code: plans.code, name: plans.name, limits: plans.limits })
    .from(organizations)
    .innerJoin(plans, eq(plans.code, organizations.planCode))
    .where(eq(organizations.id, orgId));
  if (!plan) throw new BusinessError(404, 'not_found', 'Recurso no encontrado');
  const raw = (plan.limits ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);
  const [{ b }] = (await tx
    .select({ b: sql<number>`count(*)::int` })
    .from(branches)
    .where(and(eq(branches.organizationId, orgId), eq(branches.status, 'active')))) as [{ b: number }];
  const [{ s }] = (await tx
    .select({ s: sql<number>`count(*)::int` })
    .from(organizationUsers)
    .where(
      and(
        eq(organizationUsers.organizationId, orgId),
        eq(organizationUsers.role, 'staff'),
        eq(organizationUsers.status, 'active'),
      ),
    )) as [{ s: number }];
  return {
    plan: { code: plan.code, name: plan.name },
    /** null = sin tope. */
    limits: { branches: num(raw.branches), staff: num(raw.staff) },
    usage: { branches: b, staff: s },
  };
}

/** Lanza 409 plan_limit si agregar `adding` recursos supera el tope del plan. */
export async function assertWithinPlan(tx: Tx, orgId: string, key: LimitKey, adding = 1) {
  const u = await planUsage(tx, orgId, true);
  const max = u.limits[key];
  if (max !== null && u.usage[key] + adding > max) {
    const [one, many] = LABEL[key];
    throw new BusinessError(
      409,
      'plan_limit',
      `Tu plan ${u.plan.name} permite hasta ${max} ${max === 1 ? one : many}. Para agregar más, pide a Aiment el cambio de plan.`,
      { limit: key, max, used: u.usage[key], plan: u.plan.code },
    );
  }
}
