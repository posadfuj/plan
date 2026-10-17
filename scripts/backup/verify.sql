-- Verificación de una base restaurada (la usa restore.sh). Falla si algo no cuadra.
\set ON_ERROR_STOP on
\pset footer off

\echo 'Contenido restaurado:'
SELECT (SELECT count(*) FROM app.organizations) AS negocios,
       (SELECT count(*) FROM app.customers) AS clientes,
       (SELECT count(*) FROM app.memberships) AS tarjetas,
       (SELECT count(*) FROM app.ledger_entries) AS movimientos,
       (SELECT count(*) FROM app.wallet_passes) AS pases,
       (SELECT count(*) FROM drizzle.__drizzle_migrations) AS migraciones,
       (SELECT max(created_at) FROM app.ledger_entries) AS ultimo_movimiento;

-- 1. El saldo de cada tarjeta es exactamente la suma de su historial (la regla madre del ledger).
DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad FROM (
    SELECT m.id FROM app.memberships m
    LEFT JOIN app.ledger_entries l ON l.membership_id = m.id
    GROUP BY m.id, m.balance HAVING m.balance <> coalesce(sum(l.delta), 0)
  ) x;
  IF bad > 0 THEN RAISE EXCEPTION 'Saldos que no cuadran con el historial: % tarjeta(s)', bad; END IF;
END $$;

-- 2. Las migraciones del esquema están registradas (la API arrancaría sin re-migrar).
DO $$
BEGIN
  IF (SELECT count(*) FROM drizzle.__drizzle_migrations) = 0 THEN
    RAISE EXCEPTION 'No hay migraciones registradas';
  END IF;
END $$;

-- 3. Seguridad intacta: RLS activo en las tablas de negocio y permisos del rol de la API.
DO $$
DECLARE without_rls int;
BEGIN
  SELECT count(*) INTO without_rls FROM pg_tables t
  JOIN pg_class c ON c.relname = t.tablename AND c.relnamespace = 'app'::regnamespace
  WHERE t.schemaname = 'app' AND NOT c.relrowsecurity
    AND EXISTS (SELECT 1 FROM information_schema.columns k
                WHERE k.table_schema = 'app' AND k.table_name = t.tablename AND k.column_name = 'organization_id');
  IF without_rls > 0 THEN RAISE EXCEPTION 'Tablas con organization_id sin RLS: %', without_rls; END IF;
  IF NOT has_table_privilege('app_api', 'app.ledger_entries', 'INSERT') THEN
    RAISE EXCEPTION 'El rol app_api perdió sus permisos';
  END IF;
END $$;
\echo 'Integridad: saldos = historial · migraciones registradas · RLS y permisos intactos'
