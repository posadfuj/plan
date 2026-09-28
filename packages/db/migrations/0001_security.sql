-- Seguridad de datos de Aiment Wallet (migración manual, no generada por drizzle-kit).
--
-- 1. RLS: segunda capa de aislamiento entre negocios. La API (rol app_api) abre cada
--    transacción con set_config('app.org_id', <uuid>, true); los procesos de plataforma
--    usan set_config('app.scope', 'system', true).
-- 2. Ledger y auditoría inmutables: sin UPDATE/DELETE, ni siquiera por error.
-- 3. Rol app_api sin BYPASSRLS. El usuario con login (aiment_api) lo crea `pnpm db:roles`.

CREATE OR REPLACE FUNCTION app.tenant_ok(org uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.scope', true), '') = 'system'
      OR org = nullif(current_setting('app.org_id', true), '')::uuid
$$;
--> statement-breakpoint

-- RLS en TODA tabla del esquema app que tenga organization_id (salvo audit_logs, abajo).
-- Un test de integración verifica que ninguna tabla nueva quede sin RLS.
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
    WHERE c.table_schema = 'app' AND c.column_name = 'organization_id'
      AND tb.table_type = 'BASE TABLE' AND c.table_name <> 'audit_logs'
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON app.%I USING (app.tenant_ok(organization_id)) WITH CHECK (app.tenant_ok(organization_id))', t);
  END LOOP;
END $$;
--> statement-breakpoint

ALTER TABLE app.organizations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.organizations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON app.organizations
  USING (app.tenant_ok(id)) WITH CHECK (app.tenant_ok(id));
--> statement-breakpoint

-- Auditoría: se puede escribir siempre (también desde un tenant), pero solo se lee lo propio.
ALTER TABLE app.audit_logs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.audit_logs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY audit_read ON app.audit_logs FOR SELECT
  USING (coalesce(current_setting('app.scope', true), '') = 'system'
         OR organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY audit_insert ON app.audit_logs FOR INSERT
  WITH CHECK (coalesce(current_setting('app.scope', true), '') = 'system'
              OR organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint

-- El pasado no se edita: se bloquea UPDATE/DELETE del ledger para cualquier rol.
CREATE OR REPLACE FUNCTION app.reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% es inmutable: crea una reversa o ajuste', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_immutable BEFORE UPDATE OR DELETE ON app.ledger_entries
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON app.audit_logs
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
--> statement-breakpoint

-- Rol de la aplicación (sin login, sin BYPASSRLS).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_api') THEN
    CREATE ROLE app_api NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA app TO app_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO app_api;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO app_api;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_api;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT USAGE, SELECT ON SEQUENCES TO app_api;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON app.ledger_entries FROM app_api;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON app.audit_logs FROM app_api;

-- La cola de trabajos (pg-boss, esquema pgboss) la instala `runMigrations` con el usuario administrador
-- y concede a app_api solo uso de datos (sin CREATE).
