import { publicFilePath, readBranding } from '@aiment/core';
import { schema, type Tx } from '@aiment/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { loadCardMessage } from './message';
import type { MembershipView, ProgramView } from './types';

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
  const goal = row.mode === 'stamps' ? row.goal : null;
  const message = await loadCardMessage(tx, {
    membershipId: row.membershipId,
    programId: row.programId,
    status: row.status,
    mode: row.mode,
    balance: row.balance,
    goal: row.goal,
  });
  return {
    membershipId: row.membershipId,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    programId: row.programId,
    programName: row.programName,
    mode: row.mode,
    unitLabel: row.unitLabel,
    balance: row.balance,
    goal,
    availableRewards: row.availableRewards,
    customerDisplayName: displayName(row.fullName),
    scanUrl: `${base}/s/${row.scanToken}`,
    shortCode: row.shortCode,
    primaryColor: branding.primaryColor,
    logoUrl: walletLogoUrl(branding.logoKey, base),
    status: row.status as 'active' | 'blocked',
    message: message?.text ?? null,
  };
}

const walletLogoUrl = (logoKey: string | null, base: string) =>
  logoKey && WALLET_LOGO.test(logoKey) ? `${base}${publicFilePath(logoKey)}` : null;

/** Marca de un programa (para actualizar la clase de Google). null si no existe. */
export async function loadProgramView(
  tx: Tx,
  programId: string,
  publicBaseUrl: string,
): Promise<ProgramView | null> {
  const [row] = await tx
    .select({
      organizationId: organizations.id,
      organizationName: organizations.name,
      branding: organizations.branding,
      programId: loyaltyPrograms.id,
      programName: loyaltyPrograms.name,
    })
    .from(loyaltyPrograms)
    .innerJoin(organizations, eq(organizations.id, loyaltyPrograms.organizationId))
    .where(eq(loyaltyPrograms.id, programId));
  if (!row) return null;
  const branding = readBranding(row.branding);
  return {
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    programId: row.programId,
    programName: row.programName,
    primaryColor: branding.primaryColor,
    logoUrl: walletLogoUrl(branding.logoKey, publicBaseUrl.replace(/\/$/, '')),
  };
}
