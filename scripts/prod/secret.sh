#!/usr/bin/env bash
# Guarda una clave de producción en el VPS sin que pase por el chat ni por el repositorio.
# La corre el fundador en la Terminal de su Mac:
#   scripts/prod/secret.sh NOMBRE              → pide el valor (no se muestra al pegarlo)
#   scripts/prod/secret.sh NOMBRE --generar    → crea un valor aleatorio largo en el propio VPS
# Queda en /opt/aiment-wallet/secrets.env (solo lo lee el usuario aiment). Ver los nombres guardados
# (nunca los valores): scripts/prod/secret.sh --lista
set -euo pipefail
host="${AIMENT_VPS:-aiment-vps}"
file=/opt/aiment-wallet/secrets.env

if [[ "${1:-}" == "--lista" ]]; then
  ssh "$host" "test -f $file && cut -d= -f1 $file | sort || echo '(todavía no hay claves)'"
  exit 0
fi

name="${1:?Uso: scripts/prod/secret.sh NOMBRE [--generar]}"
[[ "$name" =~ ^[A-Z][A-Z0-9_]*$ ]] || { echo "✖ Nombre inválido: solo MAYÚSCULAS, números y _"; exit 1; }

if [[ "${2:-}" == "--generar" ]]; then
  # Se genera en el servidor: el valor nunca pasa por esta Mac.
  ssh "$host" "umask 077; touch $file; v=\$(openssl rand -base64 36 | tr -d '/+=' | cut -c1-40); tmp=\$(mktemp); grep -v '^$name=' $file > \$tmp || true; printf '%s=%s\n' '$name' \"\$v\" >> \$tmp; mv \$tmp $file; echo '✔ $name generado y guardado en el VPS'"
  exit 0
fi

read -rsp "Pega el valor de $name y presiona Enter (no se va a ver): " value; echo
[[ -n "$value" ]] || { echo "✖ Vacío: no se guardó nada"; exit 1; }
[[ "$value" != *$'\n'* ]] || { echo "✖ El valor tiene saltos de línea: esta herramienta es para valores de una línea"; exit 1; }
printf '%s' "$value" | ssh "$host" "umask 077; touch $file; v=\$(cat); tmp=\$(mktemp); grep -v '^$name=' $file > \$tmp || true; printf '%s=%s\n' '$name' \"\$v\" >> \$tmp; mv \$tmp $file; echo '✔ $name guardado en el VPS'"
