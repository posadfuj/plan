/**
 * Esquema de datos de Aiment Wallet (fuente de verdad desde la semana 1).
 * Deriva de docs/esquema-v1.1.sql. Las políticas RLS, triggers y permisos
 * viven en la migración de seguridad (migrations/*_security.sql).
 */
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigserial,
  boolean,
  char,
  check,
  date,
  index,
  inet,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const app = pgSchema('app');

const id = () => uuid('id').primaryKey().defaultRandom();
const orgId = () =>
  uuid('organization_id')
    .notNull()
    .references(() => organizations.id);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------
export const orgStatus = app.enum('org_status', [
  'draft',
  'pending_review',
  'live',
  'suspended',
  'cancelled',
]);
export const memberRole = app.enum('member_role', ['owner', 'admin', 'staff']);
export const recordStatus = app.enum('record_status', ['active', 'inactive']);
export const programMode = app.enum('program_mode', ['stamps', 'points']);
export const programStatus = app.enum('program_status', ['draft', 'active', 'archived']);
export const rewardKind = app.enum('reward_kind', ['goal', 'catalog', 'gift']);
export const membershipStatus = app.enum('membership_status', ['active', 'blocked', 'closed']);
export const customerStatus = app.enum('customer_status', ['active', 'anonymized']);
export const ledgerKind = app.enum('ledger_kind', [
  'earn',
  'bonus',
  'convert',
  'redeem',
  'adjust',
  'expire',
  'reversal',
]);
export const actorType = app.enum('actor_type', ['staff', 'owner', 'automation', 'system', 'superadmin']);
export const earnedSource = app.enum('earned_source', ['goal', 'welcome', 'automation', 'manual']);
export const earnedStatus = app.enum('earned_status', ['available', 'redeemed', 'expired', 'voided']);
export const redemptionStatus = app.enum('redemption_status', ['completed', 'voided']);
export const walletProvider = app.enum('wallet_provider', ['apple', 'google']);
export const passStatus = app.enum('pass_status', ['active', 'revoked']);
export const linkKind = app.enum('link_kind', ['registration', 'campaign', 'custom']);
export const channelKind = app.enum('channel_kind', ['qr', 'nfc', 'direct', 'unknown']);
export const tagKind = app.enum('tag_kind', ['qr', 'nfc']);
export const consentKind = app.enum('consent_kind', ['terms', 'privacy', 'marketing']);
export const recoveryChannel = app.enum('recovery_channel', ['email', 'in_store']);

// ---------------------------------------------------------------------------
// Planes y organizaciones
// ---------------------------------------------------------------------------
export const plans = app.table('plans', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  limits: jsonb('limits').notNull().default({}),
  features: jsonb('features').notNull().default({}),
  active: boolean('active').notNull().default(true),
});

export const organizations = app.table(
  'organizations',
  {
    id: id(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    legalName: text('legal_name'),
    taxId: text('tax_id'),
    category: text('category'),
    status: orgStatus('status').notNull().default('draft'),
    planCode: text('plan_code')
      .notNull()
      .references(() => plans.code),
    timezone: text('timezone').notNull().default('America/Lima'),
    currency: char('currency', { length: 3 }).notNull().default('PEN'),
    locale: text('locale').notNull().default('es-PE'),
    branding: jsonb('branding').notNull().default({}),
    settings: jsonb('settings').notNull().default({}),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [check('organizations_slug_format', sql`${t.slug} ~ '^[a-z0-9][a-z0-9-]{1,62}$'`)],
);

export const orgFeatureOverrides = app.table(
  'org_feature_overrides',
  {
    organizationId: orgId(),
    feature: text('feature').notNull(),
    value: jsonb('value').notNull(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.feature] })],
);

export const branches = app.table(
  'branches',
  {
    id: id(),
    organizationId: orgId(),
    name: text('name').notNull(),
    address: text('address'),
    latitude: numeric('latitude', { precision: 9, scale: 6 }),
    longitude: numeric('longitude', { precision: 9, scale: 6 }),
    status: recordStatus('status').notNull().default('active'),
    createdAt: createdAt(),
  },
  (t) => [index('branches_org_idx').on(t.organizationId)],
);

// ---------------------------------------------------------------------------
// Usuarios, trabajadores y dispositivos
// ---------------------------------------------------------------------------
/** users.id = auth.users.id de Supabase Auth (dueños, admins y superadmin). */
export const users = app.table(
  'users',
  {
    id: uuid('id').primaryKey(),
    email: text('email').notNull().unique(),
    fullName: text('full_name'),
    isSuperadmin: boolean('is_superadmin').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [check('users_email_lower', sql`${t.email} = lower(${t.email})`)],
);

export const organizationUsers = app.table(
  'organization_users',
  {
    id: id(),
    organizationId: orgId(),
    userId: uuid('user_id').references(() => users.id),
    displayName: text('display_name').notNull(),
    role: memberRole('role').notNull(),
    branchIds: uuid('branch_ids').array(),
    pinHash: text('pin_hash'),
    pinFailedAttempts: integer('pin_failed_attempts').notNull().default(0),
    pinLockedUntil: ts('pin_locked_until'),
    status: recordStatus('status').notNull().default('active'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('organization_users_org_user_uniq').on(t.organizationId, t.userId),
    index('organization_users_org_idx').on(t.organizationId),
    index('organization_users_user_idx').on(t.userId),
    // Dueños y admins entran con Supabase Auth; el trabajador puede no tener login (dispositivo + PIN).
    check('organization_users_login_required', sql`${t.role} = 'staff' or ${t.userId} is not null`),
  ],
);

export const workerDevices = app.table(
  'worker_devices',
  {
    id: id(),
    organizationId: orgId(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id),
    name: text('name').notNull(),
    /** Hash SHA-256 del secreto que guarda la cookie del dispositivo (el secreto no se guarda). */
    deviceSecretHash: text('device_secret_hash').notNull().unique(),
    authorizedBy: uuid('authorized_by')
      .notNull()
      .references(() => organizationUsers.id),
    lastSeenAt: ts('last_seen_at'),
    revokedAt: ts('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [index('worker_devices_org_idx').on(t.organizationId)],
);

export const staffSessions = app.table(
  'staff_sessions',
  {
    id: id(),
    organizationId: orgId(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => workerDevices.id),
    organizationUserId: uuid('organization_user_id')
      .notNull()
      .references(() => organizationUsers.id),
    /** Hash SHA-256 del token de la cookie de turno. */
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [index('staff_sessions_device_idx').on(t.deviceId, t.expiresAt)],
);

/**
 * Autorización de un dispositivo de caja: el dueño genera un código de un solo uso (10 min) que se
 * muestra como QR; el dispositivo que lo abre queda vinculado. Solo se guarda el hash del código.
 */
export const devicePairings = app.table(
  'device_pairings',
  {
    id: id(),
    organizationId: orgId(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id),
    name: text('name').notNull(),
    codeHash: text('code_hash').notNull().unique(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => organizationUsers.id),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    deviceId: uuid('device_id').references(() => workerDevices.id),
    createdAt: createdAt(),
  },
  (t) => [index('device_pairings_org_idx').on(t.organizationId, t.createdAt.desc())],
);

// ---------------------------------------------------------------------------
// Programa, reglas versionadas y premios
// ---------------------------------------------------------------------------
export const loyaltyPrograms = app.table(
  'loyalty_programs',
  {
    id: id(),
    organizationId: orgId(),
    name: text('name').notNull(),
    mode: programMode('mode').notNull(),
    unitLabel: text('unit_label').notNull().default('sellos'),
    status: programStatus('status').notNull().default('draft'),
    currentVersionId: uuid('current_version_id').references((): AnyPgColumn => programRuleVersions.id),
    design: jsonb('design').notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('one_active_program_per_org')
      .on(t.organizationId)
      .where(sql`${t.status} = 'active'`),
  ],
);

export const programRuleVersions = app.table(
  'program_rule_versions',
  {
    id: id(),
    organizationId: orgId(),
    programId: uuid('program_id')
      .notNull()
      .references((): AnyPgColumn => loyaltyPrograms.id),
    version: integer('version').notNull(),
    earnRule: jsonb('earn_rule').notNull(),
    goal: integer('goal'),
    welcomeBonus: jsonb('welcome_bonus').notNull().default({ type: 'none' }),
    limits: jsonb('limits').notNull().default({}),
    expirationMonths: integer('expiration_months'),
    createdBy: uuid('created_by').references(() => organizationUsers.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('program_rule_versions_program_version_uniq').on(t.programId, t.version),
    check('program_rule_versions_goal_positive', sql`${t.goal} is null or ${t.goal} > 0`),
    check(
      'program_rule_versions_expiration_positive',
      sql`${t.expirationMonths} is null or ${t.expirationMonths} > 0`,
    ),
  ],
);

export const rewards = app.table(
  'rewards',
  {
    id: id(),
    organizationId: orgId(),
    programId: uuid('program_id')
      .notNull()
      .references(() => loyaltyPrograms.id),
    kind: rewardKind('kind').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    cost: integer('cost'),
    validityDays: integer('validity_days'),
    active: boolean('active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index('rewards_program_idx').on(t.programId),
    check('rewards_cost_only_catalog', sql`(${t.kind} = 'catalog') = (${t.cost} is not null)`),
    check('rewards_cost_positive', sql`${t.cost} is null or ${t.cost} > 0`),
  ],
);

// ---------------------------------------------------------------------------
// Clientes (por negocio), consentimientos y membresías
// ---------------------------------------------------------------------------
export const customers = app.table(
  'customers',
  {
    id: id(),
    organizationId: orgId(),
    fullName: text('full_name'),
    phoneE164: text('phone_e164'),
    email: text('email'),
    birthDate: date('birth_date'),
    status: customerStatus('status').notNull().default('active'),
    anonymizedAt: ts('anonymized_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('customers_org_phone')
      .on(t.organizationId, t.phoneE164)
      .where(sql`${t.status} = 'active'`),
    index('customers_org_created_idx').on(t.organizationId, t.createdAt.desc()),
    check(
      'customers_required_when_active',
      sql`${t.status} = 'anonymized' or (${t.fullName} is not null and ${t.phoneE164} is not null)`,
    ),
    check('customers_phone_e164', sql`${t.phoneE164} is null or ${t.phoneE164} ~ '^\\+[1-9][0-9]{7,14}$'`),
    check('customers_email_lower', sql`${t.email} is null or ${t.email} = lower(${t.email})`),
  ],
);

export const consentVersions = app.table(
  'consent_versions',
  {
    id: id(),
    organizationId: uuid('organization_id').references(() => organizations.id),
    kind: consentKind('kind').notNull(),
    version: integer('version').notNull(),
    bodyMd: text('body_md').notNull(),
    publishedAt: ts('published_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('consent_versions_uniq').on(
      sql`coalesce(${t.organizationId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      t.kind,
      t.version,
    ),
  ],
);

export const customerConsents = app.table(
  'customer_consents',
  {
    id: id(),
    organizationId: orgId(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    consentVersionId: uuid('consent_version_id')
      .notNull()
      .references(() => consentVersions.id),
    granted: boolean('granted').notNull(),
    channel: channelKind('channel').notNull(),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [index('customer_consents_customer_idx').on(t.customerId, t.createdAt.desc())],
);

export const memberships = app.table(
  'memberships',
  {
    id: id(),
    organizationId: orgId(),
    programId: uuid('program_id')
      .notNull()
      .references(() => loyaltyPrograms.id),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    /** QR que presenta el cliente en caja (/s/...). No abre datos privados. */
    memberScanToken: text('member_scan_token').notNull().unique(),
    /**
     * Hash SHA-256 del token de la URL secreta de la tarjeta web (/m/...). El token en claro solo
     * existe en el celular del cliente; se rota (nuevo token) en cada recuperación.
     */
    webCardTokenHash: text('web_card_token_hash').notNull().unique(),
    shortCode: text('short_code').notNull(),
    balance: integer('balance').notNull().default(0),
    lifetimeEarned: integer('lifetime_earned').notNull().default(0),
    status: membershipStatus('status').notNull().default('active'),
    firstValidatedAt: ts('first_validated_at'),
    lastActivityAt: ts('last_activity_at'),
    version: integer('version').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    unique('memberships_program_customer_uniq').on(t.programId, t.customerId),
    unique('memberships_org_short_code_uniq').on(t.organizationId, t.shortCode),
    index('memberships_org_activity_idx').on(t.organizationId, t.lastActivityAt),
    check('memberships_balance_non_negative', sql`${t.balance} >= 0`),
  ],
);

/**
 * Enlaces de recuperación de tarjeta (un solo uso, vencen). Solo se guarda el hash del token:
 * el enlace en claro existe únicamente en el correo o en el QR que muestra la caja.
 */
export const cardRecoveryTokens = app.table(
  'card_recovery_tokens',
  {
    id: id(),
    organizationId: orgId(),
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => memberships.id),
    tokenHash: text('token_hash').notNull().unique(),
    channel: recoveryChannel('channel').notNull(),
    issuedBy: uuid('issued_by').references(() => organizationUsers.id),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('card_recovery_tokens_membership_idx').on(t.membershipId, t.createdAt.desc())],
);

// ---------------------------------------------------------------------------
// Ledger inmutable, premios ganados y canjes
// ---------------------------------------------------------------------------
export const ledgerEntries = app.table(
  'ledger_entries',
  {
    id: id(),
    organizationId: orgId(),
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => memberships.id),
    branchId: uuid('branch_id').references(() => branches.id),
    kind: ledgerKind('kind').notNull(),
    delta: integer('delta').notNull(),
    amountMoney: numeric('amount_money', { precision: 12, scale: 2 }),
    ruleVersionId: uuid('rule_version_id')
      .notNull()
      .references(() => programRuleVersions.id),
    actorType: actorType('actor_type').notNull(),
    actorId: uuid('actor_id'),
    deviceId: uuid('device_id').references(() => workerDevices.id),
    reason: text('reason'),
    reversesEntryId: uuid('reverses_entry_id').references((): AnyPgColumn => ledgerEntries.id),
    /** Movimiento que originó este (p. ej. la suma que completó la meta → 'convert', o el bono de bienvenida). */
    causedByEntryId: uuid('caused_by_entry_id').references((): AnyPgColumn => ledgerEntries.id),
    idempotencyKey: text('idempotency_key').notNull(),
    balanceAfter: integer('balance_after').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('ledger_entries_org_idempotency_uniq').on(t.organizationId, t.idempotencyKey),
    index('ledger_entries_membership_idx').on(t.organizationId, t.membershipId, t.createdAt.desc()),
    index('ledger_entries_org_created_idx').on(t.organizationId, t.createdAt.desc()),
    index('ledger_entries_actor_idx').on(t.organizationId, t.actorId, t.createdAt.desc()),
    index('ledger_entries_caused_by_idx')
      .on(t.causedByEntryId)
      .where(sql`${t.causedByEntryId} is not null`),
    uniqueIndex('ledger_single_reversal')
      .on(t.reversesEntryId)
      .where(sql`${t.reversesEntryId} is not null`),
    check('ledger_entries_delta_non_zero', sql`${t.delta} <> 0`),
    check('ledger_entries_reversal_ref', sql`(${t.kind} = 'reversal') = (${t.reversesEntryId} is not null)`),
    check('ledger_entries_adjust_reason', sql`${t.kind} <> 'adjust' or ${t.reason} is not null`),
    check('ledger_entries_balance_non_negative', sql`${t.balanceAfter} >= 0`),
  ],
);

export const earnedRewards = app.table(
  'earned_rewards',
  {
    id: id(),
    organizationId: orgId(),
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => memberships.id),
    rewardId: uuid('reward_id')
      .notNull()
      .references(() => rewards.id),
    source: earnedSource('source').notNull(),
    sourceEntryId: uuid('source_entry_id').references(() => ledgerEntries.id),
    status: earnedStatus('status').notNull().default('available'),
    expiresAt: ts('expires_at'),
    createdAt: createdAt(),
    redeemedAt: ts('redeemed_at'),
  },
  (t) => [
    index('earned_rewards_available_idx')
      .on(t.membershipId)
      .where(sql`${t.status} = 'available'`),
  ],
);

export const redemptions = app.table(
  'redemptions',
  {
    id: id(),
    organizationId: orgId(),
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => memberships.id),
    rewardId: uuid('reward_id')
      .notNull()
      .references(() => rewards.id),
    earnedRewardId: uuid('earned_reward_id').references(() => earnedRewards.id),
    ledgerEntryId: uuid('ledger_entry_id').references(() => ledgerEntries.id),
    branchId: uuid('branch_id').references(() => branches.id),
    organizationUserId: uuid('organization_user_id').references(() => organizationUsers.id),
    deviceId: uuid('device_id').references(() => workerDevices.id),
    idempotencyKey: text('idempotency_key').notNull(),
    status: redemptionStatus('status').notNull().default('completed'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('redemptions_org_idempotency_uniq').on(t.organizationId, t.idempotencyKey),
    uniqueIndex('redemptions_single_use')
      .on(t.earnedRewardId)
      .where(sql`${t.earnedRewardId} is not null and ${t.status} = 'completed'`),
    check('redemptions_one_source', sql`(${t.earnedRewardId} is null) <> (${t.ledgerEntryId} is null)`),
  ],
);

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------
export const walletPasses = app.table(
  'wallet_passes',
  {
    id: id(),
    organizationId: orgId(),
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => memberships.id),
    provider: walletProvider('provider').notNull(),
    /** Cuenta/equipo emisor con que se emitió el pase (permite convivir cuentas y reemitir). */
    issuerRef: text('issuer_ref').notNull(),
    /** Apple serialNumber / Google objectId. Nunca un id interno. */
    externalId: text('external_id').notNull(),
    authTokenHash: text('auth_token_hash'),
    passVersion: integer('pass_version').notNull().default(1),
    status: passStatus('status').notNull().default('active'),
    lastSyncedAt: ts('last_synced_at'),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('wallet_passes_provider_external_uniq').on(t.provider, t.externalId),
    // Un pase activo por proveedor; los reemitidos dejan el anterior como 'revoked'.
    uniqueIndex('wallet_passes_active_per_provider')
      .on(t.membershipId, t.provider)
      .where(sql`${t.status} = 'active'`),
  ],
);

export const appleDevices = app.table('apple_devices', {
  id: id(),
  deviceLibraryId: text('device_library_id').notNull().unique(),
  pushToken: text('push_token').notNull(),
  createdAt: createdAt(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const appleRegistrations = app.table(
  'apple_registrations',
  {
    appleDeviceId: uuid('apple_device_id')
      .notNull()
      .references(() => appleDevices.id, { onDelete: 'cascade' }),
    walletPassId: uuid('wallet_pass_id')
      .notNull()
      .references(() => walletPasses.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.appleDeviceId, t.walletPassId] }),
    index('apple_registrations_pass_idx').on(t.walletPassId),
  ],
);

export const googleWalletClasses = app.table('google_wallet_classes', {
  id: id(),
  organizationId: orgId(),
  programId: uuid('program_id')
    .notNull()
    .references(() => loyaltyPrograms.id),
  issuerRef: text('issuer_ref').notNull(),
  classId: text('class_id').notNull().unique(),
  reviewStatus: text('review_status'),
  lastSyncedAt: ts('last_synced_at'),
  lastError: text('last_error'),
});

// ---------------------------------------------------------------------------
// URLs cortas, material físico y medición de canal
// ---------------------------------------------------------------------------
export const shortLinks = app.table(
  'short_links',
  {
    id: id(),
    slug: text('slug').notNull().unique(),
    organizationId: orgId(),
    branchId: uuid('branch_id').references(() => branches.id),
    kind: linkKind('kind').notNull().default('registration'),
    target: text('target').notNull(),
    status: recordStatus('status').notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('short_links_org_idx').on(t.organizationId)],
);

export const physicalTags = app.table('physical_tags', {
  id: id(),
  organizationId: orgId(),
  shortLinkId: uuid('short_link_id')
    .notNull()
    .references(() => shortLinks.id),
  kind: tagKind('kind').notNull(),
  internalCode: text('internal_code').notNull().unique(),
  nfcUid: text('nfc_uid'),
  locked: boolean('locked').notNull().default(false),
  deliveredAt: ts('delivered_at'),
  notes: text('notes'),
});

export const channelVisits = app.table(
  'channel_visits',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    organizationId: orgId(),
    shortLinkId: uuid('short_link_id')
      .notNull()
      .references(() => shortLinks.id),
    channel: channelKind('channel').notNull(),
    visitorHash: text('visitor_hash'),
    convertedMembershipId: uuid('converted_membership_id').references(() => memberships.id),
    createdAt: createdAt(),
  },
  (t) => [index('channel_visits_org_created_idx').on(t.organizationId, t.createdAt.desc())],
);

// ---------------------------------------------------------------------------
// Outbox, automatizaciones y auditoría
// ---------------------------------------------------------------------------
export const eventOutbox = app.table(
  'event_outbox',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    organizationId: orgId(),
    type: text('type').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    payload: jsonb('payload').notNull().default({}),
    createdAt: createdAt(),
    dispatchedAt: ts('dispatched_at'),
    attempts: integer('attempts').notNull().default(0),
  },
  (t) => [
    index('event_outbox_pending')
      .on(t.id)
      .where(sql`${t.dispatchedAt} is null`),
  ],
);

export const automations = app.table(
  'automations',
  {
    id: id(),
    organizationId: orgId(),
    programId: uuid('program_id')
      .notNull()
      .references(() => loyaltyPrograms.id),
    key: text('key').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    config: jsonb('config').notNull().default({}),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [unique('automations_program_key_uniq').on(t.programId, t.key)],
);

export const automationRuns = app.table('automation_runs', {
  id: id(),
  organizationId: orgId(),
  automationId: uuid('automation_id')
    .notNull()
    .references(() => automations.id),
  membershipId: uuid('membership_id')
    .notNull()
    .references(() => memberships.id),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  status: text('status').notNull(),
  result: jsonb('result'),
  createdAt: createdAt(),
});

export const auditLogs = app.table(
  'audit_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    organizationId: uuid('organization_id').references(() => organizations.id),
    actorType: actorType('actor_type').notNull(),
    actorId: uuid('actor_id'),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    ip: inet('ip'),
    createdAt: createdAt(),
  },
  (t) => [index('audit_logs_org_created_idx').on(t.organizationId, t.createdAt.desc())],
);

export const subscriptions = app.table('subscriptions', {
  id: id(),
  organizationId: uuid('organization_id')
    .notNull()
    .unique()
    .references(() => organizations.id),
  planCode: text('plan_code')
    .notNull()
    .references(() => plans.code),
  status: text('status').notNull().default('trial'),
  currentPeriodEnd: ts('current_period_end'),
  provider: text('provider'),
  providerRef: text('provider_ref'),
  createdAt: createdAt(),
});
