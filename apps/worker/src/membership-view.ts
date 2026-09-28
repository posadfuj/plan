import { schema, type Tx } from '@aiment/db';
import type { MembershipView } from '@aiment/wallet';
import { and, eq, sql } from 'drizzle-orm';

const { memberships, customers, loyaltyPrograms, organizations, programRuleVersions } = schema;

/** "Ana Quispe" → "Ana Q." (el pase no necesita el apellido completo). */
export function displayName(fullName: string | null): string {
  if (!fullName) return 'Cliente';
  const [first, ...rest] = fullName.trim().split(/\s+/);
  return rest.length ? `${first} ${rest[0]![0]}.` : first!;
}

export async function loadMembershipView(
  tx: Tx,
  membershipId: string,
  publicBaseUrl: string,
): Promise<MembershipView | null> {
  const [row] = await tx
    .select({
      membershipId: memberships.id,
      organizationId: memberships.organizationId,
      organizationName: organizations.name,
      branding: organizations.branding,
      programName: loyaltyPrograms.name,
      mode: loyaltyPrograms.mode,
      unitLabel: loyaltyPrograms.unitLabel,
      goal: programRuleVersions.goal,
      balance: memberships.balance,
      shortCode: memberships.shortCode,
      scanToken: memberships.memberScanToken,
      fullName: customers.fullName,
      availableRewards: sql<number>`(select count(*)::int from app.earned_rewards er where er.membership_id = ${memberships.id} and er.status = 'available')`,
    })
    .from(memberships)
    .innerJoin(customers, eq(customers.id, memberships.customerId))
    .innerJoin(loyaltyPrograms, eq(loyaltyPrograms.id, memberships.programId))
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .leftJoin(programRuleVersions, eq(programRuleVersions.id, loyaltyPrograms.currentVersionId))
    .where(and(eq(memberships.id, membershipId)));
  if (!row) return null;
  const branding = (row.branding ?? {}) as { primaryColor?: string };
  return {
    membershipId: row.membershipId,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    programName: row.programName,
    mode: row.mode,
    unitLabel: row.unitLabel,
    balance: row.balance,
    goal: row.mode === 'stamps' ? row.goal : null,
    availableRewards: row.availableRewards,
    customerDisplayName: displayName(row.fullName),
    scanUrl: `${publicBaseUrl.replace(/\/$/, '')}/s/${row.scanToken}`,
    shortCode: row.shortCode,
    primaryColor: branding.primaryColor ?? null,
  };
}
