import { publicFilePath, readBranding } from '@aiment/core';
import { schema, type Tx } from '@aiment/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { MembershipView } from './types';

const { memberships, customers, loyaltyPrograms, organizations, programRuleVersions } = schema;

/** "Ana Quispe" → "Ana Q." (el pase no necesita el apellido completo). */
export function displayName(fullName: string | null): string {
  if (!fullName) return 'Cliente';
  const [first, ...rest] = fullName.trim().split(/\s+/);
  return rest.length ? `${first} ${rest[0]![0]}.` : first!;
}

/** Google Wallet solo acepta PNG y JPG: un logo WebP usa el logo por defecto. */
const WALLET_LOGO = /\.(png|jpe?g)$/i;

/** Lo que muestra un pase. null si la membresía no existe o está cerrada. */
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
      programId: loyaltyPrograms.id,
      programName: loyaltyPrograms.name,
      mode: loyaltyPrograms.mode,
      unitLabel: loyaltyPrograms.unitLabel,
      goal: programRuleVersions.goal,
      balance: memberships.balance,
      status: memberships.status,
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
    .where(and(eq(memberships.id, membershipId), inArray(memberships.status, ['active', 'blocked'])));
  if (!row) return null;
  const branding = readBranding(row.branding);
  const base = publicBaseUrl.replace(/\/$/, '');
  return {
    membershipId: row.membershipId,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    programId: row.programId,
    programName: row.programName,
    mode: row.mode,
    unitLabel: row.unitLabel,
    balance: row.balance,
    goal: row.mode === 'stamps' ? row.goal : null,
    availableRewards: row.availableRewards,
    customerDisplayName: displayName(row.fullName),
    scanUrl: `${base}/s/${row.scanToken}`,
    shortCode: row.shortCode,
    primaryColor: branding.primaryColor,
    logoUrl:
      branding.logoKey && WALLET_LOGO.test(branding.logoKey)
        ? `${base}${publicFilePath(branding.logoKey)}`
        : null,
    status: row.status as 'active' | 'blocked',
  };
}
