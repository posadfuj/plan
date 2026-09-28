-- RLS para tablas nuevas con organization_id (la migración 0001 solo cubrió las existentes).
-- El test "toda tabla con organization_id tiene RLS" detecta si se olvida este paso.
ALTER TABLE app.card_recovery_tokens ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.card_recovery_tokens FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON app.card_recovery_tokens
  USING (app.tenant_ok(organization_id)) WITH CHECK (app.tenant_ok(organization_id));
