/**
 * Matriz de permisos de Aiment Wallet.
 * Núcleo puro: no conoce HTTP ni base de datos. La API la consulta con `can()`.
 */
export const ORG_ROLES = ['owner', 'admin', 'staff'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const ORG_ACTIONS = [
  'org.read',
  'org.branding.update',
  'program.manage',
  'rewards.manage',
  'automations.manage',
  'customers.read',
  'customers.search',
  'customers.manage',
  'customers.export',
  'membership.read',
  'membership.recovery',
  'ledger.read',
  'ledger.earn',
  'ledger.redeem',
  'ledger.void.own_recent',
  'ledger.void.any',
  'ledger.adjust',
  'limits.override',
  'team.read',
  'team.manage_staff',
  'team.manage_admins',
  'devices.manage',
  'links.manage',
  'reports.read',
  'audit.read',
] as const;
export type OrgAction = (typeof ORG_ACTIONS)[number];

export const PLATFORM_ACTIONS = [
  'platform.orgs.read',
  'platform.orgs.create',
  'platform.orgs.suspend',
  'platform.plans.manage',
  'platform.audit.read',
] as const;
export type PlatformAction = (typeof PLATFORM_ACTIONS)[number];

const STAFF: readonly OrgAction[] = [
  'org.read',
  'customers.search',
  'membership.read',
  'membership.recovery',
  'ledger.earn',
  'ledger.redeem',
  'ledger.void.own_recent',
];

// El admin opera el negocio completo, pero no gestiona a otros admins/dueños ni ve la auditoría.
const ADMIN: readonly OrgAction[] = ORG_ACTIONS.filter(
  (a) => a !== 'team.manage_admins' && a !== 'audit.read',
);

const OWNER: readonly OrgAction[] = ORG_ACTIONS;

const MATRIX: Record<OrgRole, ReadonlySet<OrgAction>> = {
  owner: new Set(OWNER),
  admin: new Set(ADMIN),
  staff: new Set(STAFF),
};

export type Actor =
  | { kind: 'superadmin'; userId: string }
  | { kind: 'member'; userId: string; orgId: string; orgUserId: string; role: OrgRole }
  | { kind: 'system' };

/** ¿Puede este rol ejecutar esta acción dentro de su organización? */
export function roleCan(role: OrgRole, action: OrgAction): boolean {
  return MATRIX[role].has(action);
}

/**
 * Autorización de una acción sobre una organización concreta.
 * El superadmin NO lee datos de clientes de un negocio (eso será el "modo soporte" auditado, fase 2).
 */
export function can(actor: Actor, action: OrgAction | PlatformAction, orgId?: string): boolean {
  switch (actor.kind) {
    case 'system':
      return true;
    case 'superadmin':
      return (PLATFORM_ACTIONS as readonly string[]).includes(action);
    case 'member':
      if (orgId === undefined || orgId !== actor.orgId) return false;
      return (ORG_ACTIONS as readonly string[]).includes(action) && roleCan(actor.role, action as OrgAction);
  }
}
