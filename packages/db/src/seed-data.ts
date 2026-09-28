/**
 * Identificadores fijos de los datos de prueba. Los usan el seed, los tests y la demo.
 * Todo es ficticio: nunca cargar datos reales en entornos locales.
 */
export const SEED_PASSWORD_ENV = 'SEED_USER_PASSWORD';

const u = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

export const SEED = {
  superadmin: { id: u(0x1), email: 'superadmin@aiment.test', name: 'Superadmin Aiment' },
  orgs: {
    barberia: {
      id: u(0xa0),
      slug: 'barberia-pedro',
      name: 'Barbería Pedro',
      category: 'barberia',
      branchId: u(0xa1),
      programId: u(0xa2),
      ruleVersionId: u(0xa3),
      rewardId: u(0xa4),
      linkSlug: 'BRB2K',
      owner: { id: u(0xa10), orgUserId: u(0xa11), email: 'dueno.barberia@aiment.test', name: 'Pedro Ramos' },
      admin: {
        id: u(0xa20),
        orgUserId: u(0xa21),
        email: 'admin.barberia@aiment.test',
        name: 'Lucía Paredes',
      },
      staff: [
        { orgUserId: u(0xa31), name: 'Jhon (caja)' },
        { orgUserId: u(0xa32), name: 'Mario (caja)' },
      ],
      customers: 30,
    },
    cafe: {
      id: u(0xb0),
      slug: 'cafe-aroma',
      name: 'Café Aroma',
      category: 'cafeteria',
      branchId: u(0xb1),
      programId: u(0xb2),
      ruleVersionId: u(0xb3),
      rewardId: u(0xb4),
      linkSlug: 'CAF7M',
      owner: { id: u(0xb10), orgUserId: u(0xb11), email: 'dueno.cafe@aiment.test', name: 'Rosa Quispe' },
      admin: null,
      staff: [{ orgUserId: u(0xb31), name: 'Ana (caja)' }],
      customers: 30,
    },
    veterinaria: {
      id: u(0xc0),
      slug: 'veterinaria-patitas',
      name: 'Veterinaria Patitas',
      category: 'veterinaria',
      branchId: u(0xc1),
      programId: u(0xc2),
      ruleVersionId: u(0xc3),
      rewardId: u(0xc4),
      linkSlug: 'VET4P',
      owner: { id: u(0xc10), orgUserId: u(0xc11), email: 'dueno.vet@aiment.test', name: 'Carlos Mendoza' },
      admin: null,
      staff: [{ orgUserId: u(0xc31), name: 'Sofía (caja)' }],
      customers: 12,
    },
  },
  /**
   * PIN de caja de todos los trabajadores del seed y PIN del dueño/admin (autoriza excepciones en caja).
   * Solo para datos de prueba: en un negocio real cada persona define el suyo.
   */
  pins: { staff: '2580', owner: '1470' },
  /** Celular presente en la barbería y en la veterinaria: prueba que el cliente es por negocio. */
  sharedPhone: '+51987000001',
} as const;

export type SeedOrgKey = keyof typeof SEED.orgs;

/** IDs deterministas de clientes y membresías por negocio (índice desde 1). */
export function seedCustomerId(org: SeedOrgKey, i: number): string {
  const base = { barberia: 0xa000, cafe: 0xb000, veterinaria: 0xc000 }[org];
  return u(0x100000 + base + i);
}
export function seedMembershipId(org: SeedOrgKey, i: number): string {
  const base = { barberia: 0xa000, cafe: 0xb000, veterinaria: 0xc000 }[org];
  return u(0x200000 + base + i);
}

export function seedUsers() {
  const list: { id: string; email: string; name: string; superadmin: boolean }[] = [
    { ...SEED.superadmin, superadmin: true },
  ];
  for (const org of Object.values(SEED.orgs)) {
    list.push({ ...org.owner, superadmin: false });
    if (org.admin) list.push({ ...org.admin, superadmin: false });
  }
  return list;
}
