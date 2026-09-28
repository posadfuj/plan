CREATE TABLE "app"."device_pairings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"device_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_pairings_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
ALTER TABLE "app"."memberships" RENAME COLUMN "web_card_token" TO "web_card_token_hash";--> statement-breakpoint
-- La URL de la tarjeta deja de guardarse en claro: se reemplaza por su hash SHA-256 (mismo cálculo que hashToken()).
-- Las tarjetas ya entregadas siguen funcionando: el cliente conserva el token y la API compara hashes.
UPDATE "app"."memberships" SET "web_card_token_hash" = encode(sha256(convert_to("web_card_token_hash", 'UTF8')), 'hex');--> statement-breakpoint
ALTER TABLE "app"."memberships" DROP CONSTRAINT "memberships_web_card_token_unique";--> statement-breakpoint
-- Las sesiones de caja se estrenan en esta versión; si hubiera alguna de prueba, se descarta.
DELETE FROM "app"."staff_sessions";--> statement-breakpoint
ALTER TABLE "app"."staff_sessions" ADD COLUMN "token_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."device_pairings" ADD CONSTRAINT "device_pairings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."device_pairings" ADD CONSTRAINT "device_pairings_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "app"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."device_pairings" ADD CONSTRAINT "device_pairings_created_by_organization_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "app"."organization_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."device_pairings" ADD CONSTRAINT "device_pairings_device_id_worker_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "app"."worker_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_pairings_org_idx" ON "app"."device_pairings" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "app"."memberships" ADD CONSTRAINT "memberships_web_card_token_hash_unique" UNIQUE("web_card_token_hash");--> statement-breakpoint
ALTER TABLE "app"."staff_sessions" ADD CONSTRAINT "staff_sessions_token_hash_unique" UNIQUE("token_hash");--> statement-breakpoint
ALTER TABLE "app"."worker_devices" ADD CONSTRAINT "worker_devices_device_secret_hash_unique" UNIQUE("device_secret_hash");--> statement-breakpoint
-- RLS de la tabla nueva (la migración 0001 solo cubrió las existentes).
ALTER TABLE app.device_pairings ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE app.device_pairings FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON app.device_pairings
  USING (app.tenant_ok(organization_id)) WITH CHECK (app.tenant_ok(organization_id));
