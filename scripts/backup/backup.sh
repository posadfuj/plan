#!/usr/bin/env bash
# Respaldo cifrado de la base de Aiment Wallet (lo corre GitHub Actions cada 6 horas).
#
# Qué guarda:
#   app.dump  → esquemas app (todo el negocio), drizzle (migraciones aplicadas) y pgboss (colas)
#   auth.dump → solo datos de auth.users y auth.identities (login de dueños y admins de Supabase);
#               sin ellos, al restaurar en un proyecto nuevo los dueños quedarían sin su negocio.
# Cómo: pg_dump → tar → cifrado con age (clave PÚBLICA; la privada nunca está aquí ni en R2) → R2.
#
# Variables:
#   BACKUP_DATABASE_URL   conexión con permisos de lectura total (Supabase: usuario postgres, pooler de sesión)
#   AGE_RECIPIENT         clave pública de age (age1…)
#   BACKUP_DEST           s3://<bucket> (R2) o una carpeta local (pruebas)
#   R2_ACCOUNT_ID, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY   solo si BACKUP_DEST es s3://
#   BACKUP_SKIP_AUTH=1    base sin Supabase Auth (pruebas locales)
set -euo pipefail

: "${BACKUP_DATABASE_URL:?falta BACKUP_DATABASE_URL}"
: "${AGE_RECIPIENT:?falta AGE_RECIPIENT (clave pública de age)}"
: "${BACKUP_DEST:?falta BACKUP_DEST}"

now_utc=$(date -u +%Y-%m-%dT%H%MZ)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Con permisos (GRANT a app_api): al restaurar, la API queda con exactamente los mismos.
pg_dump "$BACKUP_DATABASE_URL" --format=custom --no-owner \
  --schema=app --schema=drizzle --schema=pgboss --file="$work/app.dump"
if [[ "${BACKUP_SKIP_AUTH:-0}" != "1" ]]; then
  pg_dump "$BACKUP_DATABASE_URL" --format=custom --no-owner --data-only \
    --table=auth.users --table=auth.identities --file="$work/auth.dump"
fi
pg_dump --version > "$work/VERSION"
echo "$now_utc" >> "$work/VERSION"

name="aiment-${now_utc}.tar.age"
tar -C "$work" -cf - $(cd "$work" && ls) | age -r "$AGE_RECIPIENT" -o "$work/$name"
size=$(wc -c < "$work/$name" | tr -d ' ')

# Carpetas por retención (reglas de ciclo de vida en R2): 6h/ 7 días · daily/ 30 días · monthly/ 365 días.
# El primero de cada día va también a daily/ y el primero de cada mes a monthly/ (no depende de la
# hora exacta: GitHub a veces atrasa las tareas programadas).
s3() { aws s3 "$@" --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"; }
exists() { # exists <carpeta> <prefijo-de-nombre>
  if [[ "$BACKUP_DEST" == s3://* ]]; then s3 ls "$BACKUP_DEST/$1/$2" >/dev/null 2>&1
  else compgen -G "$BACKUP_DEST/$1/$2*" >/dev/null; fi
}
targets=("6h")
exists daily "aiment-$(date -u +%Y-%m-%d)" || targets+=("daily")
exists monthly "aiment-$(date -u +%Y-%m)" || targets+=("monthly")

for t in "${targets[@]}"; do
  if [[ "$BACKUP_DEST" == s3://* ]]; then
    : "${R2_ACCOUNT_ID:?falta R2_ACCOUNT_ID}"
    s3 cp "$work/$name" "$BACKUP_DEST/$t/$name" --only-show-errors
  else
    mkdir -p "$BACKUP_DEST/$t" && cp "$work/$name" "$BACKUP_DEST/$t/$name"
  fi
done
echo "✔ Respaldo $name ($size bytes) → ${targets[*]}"
