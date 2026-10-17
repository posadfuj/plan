#!/usr/bin/env bash
# Restaura un respaldo cifrado de Aiment Wallet en una base VACÍA y verifica su integridad.
# Procedimiento completo y casos (prueba semanal, desastre real): docs/runbook.md, sección 5.
#
#   restore.sh <respaldo.tar.age> <archivo-de-clave-age> <url-de-la-base-destino>
#
# RESTORE_AUTH=1  además restaura los usuarios de login (solo en un proyecto de Supabase nuevo).
set -euo pipefail

backup="${1:?respaldo .tar.age}"
identity="${2:?archivo con la clave privada de age}"
target="${3:?url de la base destino (vacía)}"
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

age -d -i "$identity" -o "$work/backup.tar" "$backup"
tar -C "$work" -xf "$work/backup.tar"
echo "Respaldo: $(tail -1 "$work/VERSION") · $(head -1 "$work/VERSION")"

# Los permisos del respaldo se otorgan al rol app_api: tiene que existir antes.
psql "$target" -v ON_ERROR_STOP=1 -q -c "DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_api') THEN
    CREATE ROLE app_api NOLOGIN NOBYPASSRLS;
  END IF; END \$\$;"
pg_restore --dbname="$target" --no-owner --exit-on-error "$work/app.dump"

if [[ "${RESTORE_AUTH:-0}" == "1" ]]; then
  [[ -f "$work/auth.dump" ]] || { echo "✖ El respaldo no trae usuarios de login"; exit 1; }
  pg_restore --dbname="$target" --no-owner --data-only --exit-on-error "$work/auth.dump"
elif [[ -f "$work/auth.dump" ]]; then
  # Sin Supabase Auth en el destino (prueba semanal): solo se comprueba que el archivo sea legible.
  pg_restore --list "$work/auth.dump" | grep -q "TABLE DATA auth users" \
    && echo "Usuarios de login: presentes en el respaldo (no se restauran en esta base)"
fi

psql "$target" -v ON_ERROR_STOP=1 -f "$here/verify.sql"
echo "✔ Restauración verificada"
