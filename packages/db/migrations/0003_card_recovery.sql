CREATE TYPE "app"."recovery_channel" AS ENUM('email', 'in_store');--> statement-breakpoint
CREATE TABLE "app"."card_recovery_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"channel" "app"."recovery_channel" NOT NULL,
	"issued_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_recovery_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "app"."card_recovery_tokens" ADD CONSTRAINT "card_recovery_tokens_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."card_recovery_tokens" ADD CONSTRAINT "card_recovery_tokens_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "app"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."card_recovery_tokens" ADD CONSTRAINT "card_recovery_tokens_issued_by_organization_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "app"."organization_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "card_recovery_tokens_membership_idx" ON "app"."card_recovery_tokens" USING btree ("membership_id","created_at" DESC NULLS LAST);