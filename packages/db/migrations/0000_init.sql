CREATE SCHEMA "app";
--> statement-breakpoint
CREATE TYPE "app"."actor_type" AS ENUM('staff', 'owner', 'automation', 'system', 'superadmin');--> statement-breakpoint
CREATE TYPE "app"."channel_kind" AS ENUM('qr', 'nfc', 'direct', 'unknown');--> statement-breakpoint
CREATE TYPE "app"."consent_kind" AS ENUM('terms', 'privacy', 'marketing');--> statement-breakpoint
CREATE TYPE "app"."customer_status" AS ENUM('active', 'anonymized');--> statement-breakpoint
CREATE TYPE "app"."earned_source" AS ENUM('goal', 'welcome', 'automation', 'manual');--> statement-breakpoint
CREATE TYPE "app"."earned_status" AS ENUM('available', 'redeemed', 'expired', 'voided');--> statement-breakpoint
CREATE TYPE "app"."ledger_kind" AS ENUM('earn', 'bonus', 'convert', 'redeem', 'adjust', 'expire', 'reversal');--> statement-breakpoint
CREATE TYPE "app"."link_kind" AS ENUM('registration', 'campaign', 'custom');--> statement-breakpoint
CREATE TYPE "app"."member_role" AS ENUM('owner', 'admin', 'staff');--> statement-breakpoint
CREATE TYPE "app"."membership_status" AS ENUM('active', 'blocked', 'closed');--> statement-breakpoint
CREATE TYPE "app"."org_status" AS ENUM('draft', 'pending_review', 'live', 'suspended', 'cancelled');--> statement-breakpoint
CREATE TYPE "app"."pass_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TYPE "app"."program_mode" AS ENUM('stamps', 'points');--> statement-breakpoint
CREATE TYPE "app"."program_status" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
CREATE TYPE "app"."record_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TYPE "app"."redemption_status" AS ENUM('completed', 'voided');--> statement-breakpoint
CREATE TYPE "app"."reward_kind" AS ENUM('goal', 'catalog', 'gift');--> statement-breakpoint
CREATE TYPE "app"."tag_kind" AS ENUM('qr', 'nfc');--> statement-breakpoint
CREATE TYPE "app"."wallet_provider" AS ENUM('apple', 'google');--> statement-breakpoint
CREATE TABLE "app"."apple_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_library_id" text NOT NULL,
	"push_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "apple_devices_device_library_id_unique" UNIQUE("device_library_id")
);
--> statement-breakpoint
CREATE TABLE "app"."apple_registrations" (
	"apple_device_id" uuid NOT NULL,
	"wallet_pass_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "apple_registrations_apple_device_id_wallet_pass_id_pk" PRIMARY KEY("apple_device_id","wallet_pass_id")
);
--> statement-breakpoint
CREATE TABLE "app"."audit_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"actor_type" "app"."actor_type" NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"ip" "inet",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."automation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_runs_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "app"."automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"key" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automations_program_key_uniq" UNIQUE("program_id","key")
);
--> statement-breakpoint
CREATE TABLE "app"."branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"latitude" numeric(9, 6),
	"longitude" numeric(9, 6),
	"status" "app"."record_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."channel_visits" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"short_link_id" uuid NOT NULL,
	"channel" "app"."channel_kind" NOT NULL,
	"visitor_hash" text,
	"converted_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."consent_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"kind" "app"."consent_kind" NOT NULL,
	"version" integer NOT NULL,
	"body_md" text NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."customer_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"consent_version_id" uuid NOT NULL,
	"granted" boolean NOT NULL,
	"channel" "app"."channel_kind" NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"full_name" text,
	"phone_e164" text,
	"email" text,
	"birth_date" date,
	"status" "app"."customer_status" DEFAULT 'active' NOT NULL,
	"anonymized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_required_when_active" CHECK ("app"."customers"."status" = 'anonymized' or ("app"."customers"."full_name" is not null and "app"."customers"."phone_e164" is not null)),
	CONSTRAINT "customers_phone_e164" CHECK ("app"."customers"."phone_e164" is null or "app"."customers"."phone_e164" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "customers_email_lower" CHECK ("app"."customers"."email" is null or "app"."customers"."email" = lower("app"."customers"."email"))
);
--> statement-breakpoint
CREATE TABLE "app"."earned_rewards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"reward_id" uuid NOT NULL,
	"source" "app"."earned_source" NOT NULL,
	"source_entry_id" uuid,
	"status" "app"."earned_status" DEFAULT 'available' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"redeemed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app"."event_outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."google_wallet_classes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"issuer_ref" text NOT NULL,
	"class_id" text NOT NULL,
	"review_status" text,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "google_wallet_classes_class_id_unique" UNIQUE("class_id")
);
--> statement-breakpoint
CREATE TABLE "app"."ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"branch_id" uuid,
	"kind" "app"."ledger_kind" NOT NULL,
	"delta" integer NOT NULL,
	"amount_money" numeric(12, 2),
	"rule_version_id" uuid NOT NULL,
	"actor_type" "app"."actor_type" NOT NULL,
	"actor_id" uuid,
	"device_id" uuid,
	"reason" text,
	"reverses_entry_id" uuid,
	"idempotency_key" text NOT NULL,
	"balance_after" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_org_idempotency_uniq" UNIQUE("organization_id","idempotency_key"),
	CONSTRAINT "ledger_entries_delta_non_zero" CHECK ("app"."ledger_entries"."delta" <> 0),
	CONSTRAINT "ledger_entries_reversal_ref" CHECK (("app"."ledger_entries"."kind" = 'reversal') = ("app"."ledger_entries"."reverses_entry_id" is not null)),
	CONSTRAINT "ledger_entries_adjust_reason" CHECK ("app"."ledger_entries"."kind" <> 'adjust' or "app"."ledger_entries"."reason" is not null),
	CONSTRAINT "ledger_entries_balance_non_negative" CHECK ("app"."ledger_entries"."balance_after" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."loyalty_programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"mode" "app"."program_mode" NOT NULL,
	"unit_label" text DEFAULT 'sellos' NOT NULL,
	"status" "app"."program_status" DEFAULT 'draft' NOT NULL,
	"current_version_id" uuid,
	"design" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"member_scan_token" text NOT NULL,
	"web_card_token" text NOT NULL,
	"short_code" text NOT NULL,
	"balance" integer DEFAULT 0 NOT NULL,
	"lifetime_earned" integer DEFAULT 0 NOT NULL,
	"status" "app"."membership_status" DEFAULT 'active' NOT NULL,
	"first_validated_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_member_scan_token_unique" UNIQUE("member_scan_token"),
	CONSTRAINT "memberships_web_card_token_unique" UNIQUE("web_card_token"),
	CONSTRAINT "memberships_program_customer_uniq" UNIQUE("program_id","customer_id"),
	CONSTRAINT "memberships_org_short_code_uniq" UNIQUE("organization_id","short_code"),
	CONSTRAINT "memberships_balance_non_negative" CHECK ("app"."memberships"."balance" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."org_feature_overrides" (
	"organization_id" uuid NOT NULL,
	"feature" text NOT NULL,
	"value" jsonb NOT NULL,
	CONSTRAINT "org_feature_overrides_organization_id_feature_pk" PRIMARY KEY("organization_id","feature")
);
--> statement-breakpoint
CREATE TABLE "app"."organization_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid,
	"display_name" text NOT NULL,
	"role" "app"."member_role" NOT NULL,
	"branch_ids" uuid[],
	"pin_hash" text,
	"pin_failed_attempts" integer DEFAULT 0 NOT NULL,
	"pin_locked_until" timestamp with time zone,
	"status" "app"."record_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_users_org_user_uniq" UNIQUE("organization_id","user_id"),
	CONSTRAINT "organization_users_login_required" CHECK ("app"."organization_users"."role" = 'staff' or "app"."organization_users"."user_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "app"."organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"tax_id" text,
	"category" text,
	"status" "app"."org_status" DEFAULT 'draft' NOT NULL,
	"plan_code" text NOT NULL,
	"timezone" text DEFAULT 'America/Lima' NOT NULL,
	"currency" char(3) DEFAULT 'PEN' NOT NULL,
	"locale" text DEFAULT 'es-PE' NOT NULL,
	"branding" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug"),
	CONSTRAINT "organizations_slug_format" CHECK ("app"."organizations"."slug" ~ '^[a-z0-9][a-z0-9-]{1,62}$')
);
--> statement-breakpoint
CREATE TABLE "app"."physical_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"short_link_id" uuid NOT NULL,
	"kind" "app"."tag_kind" NOT NULL,
	"internal_code" text NOT NULL,
	"nfc_uid" text,
	"locked" boolean DEFAULT false NOT NULL,
	"delivered_at" timestamp with time zone,
	"notes" text,
	CONSTRAINT "physical_tags_internal_code_unique" UNIQUE("internal_code")
);
--> statement-breakpoint
CREATE TABLE "app"."plans" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."program_rule_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"earn_rule" jsonb NOT NULL,
	"goal" integer,
	"welcome_bonus" jsonb DEFAULT '{"type":"none"}'::jsonb NOT NULL,
	"limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expiration_months" integer,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "program_rule_versions_program_version_uniq" UNIQUE("program_id","version"),
	CONSTRAINT "program_rule_versions_goal_positive" CHECK ("app"."program_rule_versions"."goal" is null or "app"."program_rule_versions"."goal" > 0),
	CONSTRAINT "program_rule_versions_expiration_positive" CHECK ("app"."program_rule_versions"."expiration_months" is null or "app"."program_rule_versions"."expiration_months" > 0)
);
--> statement-breakpoint
CREATE TABLE "app"."redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"reward_id" uuid NOT NULL,
	"earned_reward_id" uuid,
	"ledger_entry_id" uuid,
	"branch_id" uuid,
	"organization_user_id" uuid,
	"device_id" uuid,
	"idempotency_key" text NOT NULL,
	"status" "app"."redemption_status" DEFAULT 'completed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "redemptions_org_idempotency_uniq" UNIQUE("organization_id","idempotency_key"),
	CONSTRAINT "redemptions_one_source" CHECK (("app"."redemptions"."earned_reward_id" is null) <> ("app"."redemptions"."ledger_entry_id" is null))
);
--> statement-breakpoint
CREATE TABLE "app"."rewards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"kind" "app"."reward_kind" NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"cost" integer,
	"validity_days" integer,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rewards_cost_only_catalog" CHECK (("app"."rewards"."kind" = 'catalog') = ("app"."rewards"."cost" is not null)),
	CONSTRAINT "rewards_cost_positive" CHECK ("app"."rewards"."cost" is null or "app"."rewards"."cost" > 0)
);
--> statement-breakpoint
CREATE TABLE "app"."short_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"branch_id" uuid,
	"kind" "app"."link_kind" DEFAULT 'registration' NOT NULL,
	"target" text NOT NULL,
	"status" "app"."record_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "short_links_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "app"."staff_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"organization_user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"plan_code" text NOT NULL,
	"status" text DEFAULT 'trial' NOT NULL,
	"current_period_end" timestamp with time zone,
	"provider" text,
	"provider_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_organization_id_unique" UNIQUE("organization_id")
);
--> statement-breakpoint
CREATE TABLE "app"."users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"full_name" text,
	"is_superadmin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_email_lower" CHECK ("app"."users"."email" = lower("app"."users"."email"))
);
--> statement-breakpoint
CREATE TABLE "app"."wallet_passes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"provider" "app"."wallet_provider" NOT NULL,
	"issuer_ref" text NOT NULL,
	"external_id" text NOT NULL,
	"auth_token_hash" text,
	"pass_version" integer DEFAULT 1 NOT NULL,
	"status" "app"."pass_status" DEFAULT 'active' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_passes_provider_external_uniq" UNIQUE("provider","external_id")
);
--> statement-breakpoint
CREATE TABLE "app"."worker_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"name" text NOT NULL,
	"device_secret_hash" text NOT NULL,
	"authorized_by" uuid NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."apple_registrations" ADD CONSTRAINT "apple_registrations_apple_device_id_apple_devices_id_fk" FOREIGN KEY ("apple_device_id") REFERENCES "app"."apple_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."apple_registrations" ADD CONSTRAINT "apple_registrations_wallet_pass_id_wallet_passes_id_fk" FOREIGN KEY ("wallet_pass_id") REFERENCES "app"."wallet_passes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."audit_logs" ADD CONSTRAINT "audit_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."automation_runs" ADD CONSTRAINT "automation_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."automation_runs" ADD CONSTRAINT "automation_runs_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "app"."automations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."automation_runs" ADD CONSTRAINT "automation_runs_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "app"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."automations" ADD CONSTRAINT "automations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."automations" ADD CONSTRAINT "automations_program_id_loyalty_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "app"."loyalty_programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."branches" ADD CONSTRAINT "branches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."channel_visits" ADD CONSTRAINT "channel_visits_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."channel_visits" ADD CONSTRAINT "channel_visits_short_link_id_short_links_id_fk" FOREIGN KEY ("short_link_id") REFERENCES "app"."short_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."channel_visits" ADD CONSTRAINT "channel_visits_converted_membership_id_memberships_id_fk" FOREIGN KEY ("converted_membership_id") REFERENCES "app"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."consent_versions" ADD CONSTRAINT "consent_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."customer_consents" ADD CONSTRAINT "customer_consents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."customer_consents" ADD CONSTRAINT "customer_consents_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "app"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."customer_consents" ADD CONSTRAINT "customer_consents_consent_version_id_consent_versions_id_fk" FOREIGN KEY ("consent_version_id") REFERENCES "app"."consent_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."customers" ADD CONSTRAINT "customers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."earned_rewards" ADD CONSTRAINT "earned_rewards_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."earned_rewards" ADD CONSTRAINT "earned_rewards_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "app"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."earned_rewards" ADD CONSTRAINT "earned_rewards_reward_id_rewards_id_fk" FOREIGN KEY ("reward_id") REFERENCES "app"."rewards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."earned_rewards" ADD CONSTRAINT "earned_rewards_source_entry_id_ledger_entries_id_fk" FOREIGN KEY ("source_entry_id") REFERENCES "app"."ledger_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."event_outbox" ADD CONSTRAINT "event_outbox_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."google_wallet_classes" ADD CONSTRAINT "google_wallet_classes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."google_wallet_classes" ADD CONSTRAINT "google_wallet_classes_program_id_loyalty_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "app"."loyalty_programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ledger_entries" ADD CONSTRAINT "ledger_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ledger_entries" ADD CONSTRAINT "ledger_entries_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "app"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ledger_entries" ADD CONSTRAINT "ledger_entries_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "app"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ledger_entries" ADD CONSTRAINT "ledger_entries_rule_version_id_program_rule_versions_id_fk" FOREIGN KEY ("rule_version_id") REFERENCES "app"."program_rule_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ledger_entries" ADD CONSTRAINT "ledger_entries_device_id_worker_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "app"."worker_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ledger_entries" ADD CONSTRAINT "ledger_entries_reverses_entry_id_ledger_entries_id_fk" FOREIGN KEY ("reverses_entry_id") REFERENCES "app"."ledger_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."loyalty_programs" ADD CONSTRAINT "loyalty_programs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."loyalty_programs" ADD CONSTRAINT "loyalty_programs_current_version_id_program_rule_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "app"."program_rule_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."memberships" ADD CONSTRAINT "memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."memberships" ADD CONSTRAINT "memberships_program_id_loyalty_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "app"."loyalty_programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."memberships" ADD CONSTRAINT "memberships_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "app"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."org_feature_overrides" ADD CONSTRAINT "org_feature_overrides_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."organization_users" ADD CONSTRAINT "organization_users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."organization_users" ADD CONSTRAINT "organization_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."organizations" ADD CONSTRAINT "organizations_plan_code_plans_code_fk" FOREIGN KEY ("plan_code") REFERENCES "app"."plans"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."physical_tags" ADD CONSTRAINT "physical_tags_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."physical_tags" ADD CONSTRAINT "physical_tags_short_link_id_short_links_id_fk" FOREIGN KEY ("short_link_id") REFERENCES "app"."short_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."program_rule_versions" ADD CONSTRAINT "program_rule_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."program_rule_versions" ADD CONSTRAINT "program_rule_versions_program_id_loyalty_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "app"."loyalty_programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."program_rule_versions" ADD CONSTRAINT "program_rule_versions_created_by_organization_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "app"."organization_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."redemptions" ADD CONSTRAINT "redemptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."redemptions" ADD CONSTRAINT "redemptions_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "app"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."redemptions" ADD CONSTRAINT "redemptions_reward_id_rewards_id_fk" FOREIGN KEY ("reward_id") REFERENCES "app"."rewards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."redemptions" ADD CONSTRAINT "redemptions_earned_reward_id_earned_rewards_id_fk" FOREIGN KEY ("earned_reward_id") REFERENCES "app"."earned_rewards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."redemptions" ADD CONSTRAINT "redemptions_ledger_entry_id_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "app"."ledger_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."redemptions" ADD CONSTRAINT "redemptions_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "app"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."redemptions" ADD CONSTRAINT "redemptions_organization_user_id_organization_users_id_fk" FOREIGN KEY ("organization_user_id") REFERENCES "app"."organization_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."redemptions" ADD CONSTRAINT "redemptions_device_id_worker_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "app"."worker_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."rewards" ADD CONSTRAINT "rewards_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."rewards" ADD CONSTRAINT "rewards_program_id_loyalty_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "app"."loyalty_programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."short_links" ADD CONSTRAINT "short_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."short_links" ADD CONSTRAINT "short_links_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "app"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."staff_sessions" ADD CONSTRAINT "staff_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."staff_sessions" ADD CONSTRAINT "staff_sessions_device_id_worker_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "app"."worker_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."staff_sessions" ADD CONSTRAINT "staff_sessions_organization_user_id_organization_users_id_fk" FOREIGN KEY ("organization_user_id") REFERENCES "app"."organization_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."subscriptions" ADD CONSTRAINT "subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."subscriptions" ADD CONSTRAINT "subscriptions_plan_code_plans_code_fk" FOREIGN KEY ("plan_code") REFERENCES "app"."plans"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."wallet_passes" ADD CONSTRAINT "wallet_passes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."wallet_passes" ADD CONSTRAINT "wallet_passes_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "app"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."worker_devices" ADD CONSTRAINT "worker_devices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."worker_devices" ADD CONSTRAINT "worker_devices_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "app"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."worker_devices" ADD CONSTRAINT "worker_devices_authorized_by_organization_users_id_fk" FOREIGN KEY ("authorized_by") REFERENCES "app"."organization_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "apple_registrations_pass_idx" ON "app"."apple_registrations" USING btree ("wallet_pass_id");--> statement-breakpoint
CREATE INDEX "audit_logs_org_created_idx" ON "app"."audit_logs" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "branches_org_idx" ON "app"."branches" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "channel_visits_org_created_idx" ON "app"."channel_visits" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "consent_versions_uniq" ON "app"."consent_versions" USING btree (coalesce("organization_id", '00000000-0000-0000-0000-000000000000'::uuid),"kind","version");--> statement-breakpoint
CREATE INDEX "customer_consents_customer_idx" ON "app"."customer_consents" USING btree ("customer_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "customers_org_phone" ON "app"."customers" USING btree ("organization_id","phone_e164") WHERE "app"."customers"."status" = 'active';--> statement-breakpoint
CREATE INDEX "customers_org_created_idx" ON "app"."customers" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "earned_rewards_available_idx" ON "app"."earned_rewards" USING btree ("membership_id") WHERE "app"."earned_rewards"."status" = 'available';--> statement-breakpoint
CREATE INDEX "event_outbox_pending" ON "app"."event_outbox" USING btree ("id") WHERE "app"."event_outbox"."dispatched_at" is null;--> statement-breakpoint
CREATE INDEX "ledger_entries_membership_idx" ON "app"."ledger_entries" USING btree ("organization_id","membership_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ledger_entries_org_created_idx" ON "app"."ledger_entries" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ledger_entries_actor_idx" ON "app"."ledger_entries" USING btree ("organization_id","actor_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_single_reversal" ON "app"."ledger_entries" USING btree ("reverses_entry_id") WHERE "app"."ledger_entries"."reverses_entry_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "one_active_program_per_org" ON "app"."loyalty_programs" USING btree ("organization_id") WHERE "app"."loyalty_programs"."status" = 'active';--> statement-breakpoint
CREATE INDEX "memberships_org_activity_idx" ON "app"."memberships" USING btree ("organization_id","last_activity_at");--> statement-breakpoint
CREATE INDEX "organization_users_org_idx" ON "app"."organization_users" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "organization_users_user_idx" ON "app"."organization_users" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "redemptions_single_use" ON "app"."redemptions" USING btree ("earned_reward_id") WHERE "app"."redemptions"."earned_reward_id" is not null and "app"."redemptions"."status" = 'completed';--> statement-breakpoint
CREATE INDEX "rewards_program_idx" ON "app"."rewards" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "short_links_org_idx" ON "app"."short_links" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "staff_sessions_device_idx" ON "app"."staff_sessions" USING btree ("device_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_passes_active_per_provider" ON "app"."wallet_passes" USING btree ("membership_id","provider") WHERE "app"."wallet_passes"."status" = 'active';--> statement-breakpoint
CREATE INDEX "worker_devices_org_idx" ON "app"."worker_devices" USING btree ("organization_id");