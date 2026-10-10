-- Versiones de consentimiento globales (organization_id NULL: términos, privacidad y promociones de la
-- plataforma). La política de la 0001 las ocultaba dentro de la transacción de un negocio, y el panel
-- no podía saber si un cliente aceptó promociones (siempre mostraba "No acepta").
-- Son textos públicos (se muestran en el registro): cualquier negocio puede LEERLAS; escribirlas o
-- cambiarlas sigue reservado a los procesos de plataforma (app.scope = 'system').
DROP POLICY tenant_isolation ON app.consent_versions;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON app.consent_versions
  USING (app.tenant_ok(organization_id)) WITH CHECK (app.tenant_ok(organization_id));
--> statement-breakpoint
CREATE POLICY platform_versions_read ON app.consent_versions FOR SELECT
  USING (organization_id IS NULL);
