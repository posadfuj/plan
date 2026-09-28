import { describe, expect, it } from 'vitest';
import { ORG_ACTIONS, PLATFORM_ACTIONS, can, roleCan, type Actor } from './permissions';

const ORG_A = '00000000-0000-0000-0000-00000000000a';
const ORG_B = '00000000-0000-0000-0000-00000000000b';
const member = (role: 'owner' | 'admin' | 'staff'): Actor => ({
  kind: 'member',
  userId: 'u',
  orgId: ORG_A,
  orgUserId: 'ou',
  role,
});

describe('matriz de permisos', () => {
  it('el trabajador solo opera caja', () => {
    expect(roleCan('staff', 'ledger.earn')).toBe(true);
    expect(roleCan('staff', 'ledger.redeem')).toBe(true);
    expect(roleCan('staff', 'ledger.void.own_recent')).toBe(true);
    for (const a of [
      'program.manage',
      'ledger.adjust',
      'ledger.void.any',
      'customers.export',
      'reports.read',
    ] as const)
      expect(roleCan('staff', a)).toBe(false);
  });

  it('el admin no gestiona admins ni ve auditoría; el dueño sí', () => {
    expect(roleCan('admin', 'program.manage')).toBe(true);
    expect(roleCan('admin', 'team.manage_admins')).toBe(false);
    expect(roleCan('admin', 'audit.read')).toBe(false);
    for (const a of ORG_ACTIONS) expect(roleCan('owner', a)).toBe(true);
  });

  it('ningún miembro actúa sobre otra organización', () => {
    for (const role of ['owner', 'admin', 'staff'] as const)
      for (const a of ORG_ACTIONS) expect(can(member(role), a, ORG_B)).toBe(false);
  });

  it('un miembro no ejecuta acciones de plataforma', () => {
    for (const a of PLATFORM_ACTIONS) expect(can(member('owner'), a, ORG_A)).toBe(false);
  });

  it('el superadmin gestiona la plataforma pero no lee clientes de un negocio', () => {
    const sa: Actor = { kind: 'superadmin', userId: 's' };
    for (const a of PLATFORM_ACTIONS) expect(can(sa, a)).toBe(true);
    expect(can(sa, 'customers.read', ORG_A)).toBe(false);
    expect(can(sa, 'ledger.earn', ORG_A)).toBe(false);
  });
});
