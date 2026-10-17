# Runbook de Aiment Wallet

Cómo se opera el sistema: qué corre, qué variables necesita, cómo se migra la base y cómo se hace (y se restaura) un respaldo. Vale para local y producción. La producción (VPS, Cloudflare, Supabase) está en la sección 10.

## 1. Qué corre

| Pieza                      | Qué hace                                                                                   | Local                                  |
| -------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------- |
| **API** (`apps/api`)       | Hono sobre Node. Panel, caja, flujo público. Valida sesiones de Supabase Auth (JWKS/HS256) | `pnpm dev` → `http://localhost:8787`   |
| **PWA** (`apps/web`)       | Tarjeta del cliente, caja, panel y panel maestro                                           | `pnpm dev` → `http://localhost:5173`   |
| **Worker** (`apps/worker`) | Outbox → colas de Wallet (una por proveedor) y **vencimientos programados** (pg-boss)      | `pnpm dev`                             |
| **Postgres 17**            | Esquemas `app` (datos), `drizzle` (historial de migraciones) y `pgboss` (colas)            | Supabase local (`pnpm local:up`)       |
| **Supabase Auth**          | Login de dueños, admins y superadmin; invitaciones                                         | Supabase local                         |
| **SMTP**                   | Correos de recuperación e invitación                                                       | Mailpit: `http://127.0.0.1:54324`      |
| **Archivos**               | Logos (`STORAGE_DIR`)                                                                      | `.data/storage` (en producción, R2/S3) |

Salud: `GET /health` (API + consulta a la base). El worker escribe en su salida estándar.

## 2. Variables de entorno

La lista completa con comentarios está en [`.env.example`](../.env.example). En local no se edita a mano: `pnpm local:env` genera `.env` (que **nunca** se sube al repositorio).

| Variable                                                  | Para qué                                                                                                   | Producción                                                 |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `DATABASE_ADMIN_URL`                                      | Migraciones y seed (dueño del esquema). **Nunca** la usa la API                                            | Solo en el paso de despliegue                              |
| `DATABASE_URL`, `APP_DB_USER`, `APP_DB_PASSWORD`          | API y worker: usuario miembro de `app_api`, **sin BYPASSRLS**                                              | Clave larga y única, en el gestor de secretos              |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`                | Login del panel                                                                                            | Proyecto de Supabase                                       |
| `SUPABASE_SECRET_KEY`                                     | Invitaciones de dueños (solo servidor)                                                                     | Secreto                                                    |
| `SUPABASE_JWT_SECRET`                                     | Solo local/legacy (HS256)                                                                                  | Vacío: la API valida con JWKS                              |
| `AUTH_REQUIRE_SUPERADMIN_MFA`                             | Superadmin con TOTP                                                                                        | `true`                                                     |
| `PUBLIC_BASE_URL`                                         | Enlaces que salen del sistema (correos, QR, PDF de mostrador)                                              | `https://{dominio}`                                        |
| `TRUST_PROXY`                                             | IP real desde `X-Forwarded-For`                                                                            | `true` detrás de Cloudflare                                |
| `VISITOR_HASH_SALT`                                       | Hash diario de visitantes (no se guarda la IP)                                                             | Aleatorio, 32+ caracteres                                  |
| `RATE_LIMIT_*`                                            | Suben los límites por IP para probar en local                                                              | **Vacías** (valores por defecto, ver ADR 0003)             |
| `MAIL_TRANSPORT`, `SMTP_*`, `MAIL_FROM`, `RESEND_API_KEY` | Correo: `smtp` (Mailpit local) o `resend`                                                                  | `resend` + `RESEND_API_KEY`, remitente `@aimentwallet.com` |
| `STORAGE_DRIVER`, `STORAGE_DIR`, `R2_*`                   | Logos: `local` (carpeta) o `r2` (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`) | `r2`, token limitado al bucket de archivos                 |
| `ALERT_WEBHOOK_URL`, `ALERT_EMAIL`                        | Avisos de operación (sección 10)                                                                           | Webhook de n8n (WhatsApp) y/o correo                       |
| `GOOGLE_WALLET_MODE`                                      | Google Wallet: `auto` (real si hay credenciales y https; si no, simulado), `simulated`, `live`, `off`      | `live` (no arranca si falta algo)                          |
| `GOOGLE_WALLET_ISSUER_ID`, `GOOGLE_WALLET_SA_JSON_PATH`   | Cuenta emisora y cuenta de servicio de Google Wallet                                                       | Archivo en `secrets/` (nunca en git)                       |

## 3. Migraciones

```bash
pnpm db:migrate     # aplica migrations/ con DATABASE_ADMIN_URL (idempotente)
pnpm db:roles       # crea/actualiza APP_DB_USER (login, sin BYPASSRLS) y le da app_api
pnpm db:check       # el esquema de Drizzle y las migraciones están sincronizados (lo corre CI)
```

- Las migraciones viven en `packages/db/migrations` (Drizzle). Las de **seguridad** (RLS, permisos, inmutabilidad del ledger) son SQL a mano: `drizzle-kit generate --custom --name <nombre>`.
- **Toda tabla nueva con `organization_id` necesita RLS** (ver `0004_card_recovery_rls.sql`). Un test de integración falla si se olvida.
- Orden en un despliegue: 1) respaldo, 2) `db:migrate`, 3) API y worker nuevos. Las migraciones se escriben compatibles con la versión anterior de la API (agregar antes de quitar).
- `pnpm db:reset` **borra todo** y vuelve al seed: solo local y test.

## 4. Trabajos programados

| Trabajo          | Cuándo                                                                     | Qué hace                                                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loyalty.expire` | Cada hora (minuto 7, UTC). Cada negocio, a las **3:00 de su zona horaria** | Vence premios con vigencia y, si el negocio lo configuró, saldos inactivos (en el piloto: desactivado). Idempotente                                                                          |
| Outbox           | Cada segundo                                                               | Encola la sincronización de pases de Wallet (una cola por proveedor, con reintentos)                                                                                                         |
| `ops.cleanup`    | Todos los días, 08:30 UTC (03:30 en Lima)                                  | Borra lo temporal vencido hace más de 30 días: eventos ya procesados, turnos de caja, códigos de vinculación y enlaces de recuperación. **Nunca** el ledger, clientes, auditoría ni reportes |
| `ops.health`     | Cada 15 minutos (solo con avisos configurados)                             | Tamaño de la base, RAM, disco y carga del servidor, atrasos y errores de Wallet → avisos (sección 10)                                                                                        |
| pg-boss          | Continuo                                                                   | Borra los trabajos terminados a los 3 días                                                                                                                                                   |

Si el worker estuvo caído, al volver el siguiente trabajo horario procesa a los negocios que estén a las 3:00; los que se saltaron se ponen al día al día siguiente (el vencimiento compara contra la fecha, no contra la hora del trabajo).

## 5. Respaldo y restauración

**Producción:** respaldo **cifrado cada 6 horas** hacia Cloudflare R2, hecho por GitHub Actions (`.github/workflows/backup.yml`), fuera del VPS. Si el servidor se cae, los respaldos siguen. Supabase Free no trae respaldos automáticos; este es el único.

| Qué               | Detalle                                                                                                                                                                                                                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contenido         | `app` (todo el negocio), `drizzle` (migraciones), `pgboss` (colas) y los usuarios de login (`auth.users`, `auth.identities`)                                                                                                                                                                   |
| Cifrado           | [age](https://age-encryption.org) con la clave **pública** en el repositorio (`vars.BACKUP_AGE_RECIPIENT`). La **privada** la guarda el fundador fuera de línea (gestor de contraseñas + una copia) y una copia en el entorno protegido `restore-test` de GitHub. **Nunca en R2**              |
| Retención         | `6h/` 7 días · `daily/` 30 días · `monthly/` 12 meses, con reglas de ciclo de vida de R2 (`scripts/backup/r2-lifecycle.json`)                                                                                                                                                                  |
| Pérdida máxima    | 6 horas de operaciones (Supabase Pro respalda una vez al día)                                                                                                                                                                                                                                  |
| Prueba automática | Cada lunes (`restore-test.yml`): baja el último respaldo, lo restaura en un Postgres vacío y verifica que **cada saldo sea igual a la suma de su historial**, que las migraciones estén registradas y que RLS y permisos sigan intactos. También falla si el último respaldo tiene más de 12 h |
| Avisos            | Si un respaldo o la prueba fallan: correo de GitHub + webhook `ALERT_WEBHOOK_URL`                                                                                                                                                                                                              |

Configuración en GitHub (una sola vez): entorno `production-backup` con los secretos `BACKUP_DATABASE_URL` (usuario `postgres` de Supabase por el pooler de **sesión**), `BACKUP_R2_ACCESS_KEY_ID` y `BACKUP_R2_SECRET_ACCESS_KEY` (token de R2 limitado al bucket de respaldos); entorno `restore-test` con `BACKUP_AGE_IDENTITY` y las mismas claves de R2; variables del repositorio `BACKUP_R2_BUCKET`, `R2_ACCOUNT_ID` y `BACKUP_AGE_RECIPIENT`. Los flujos no corren hasta que exista `BACKUP_R2_BUCKET`.

### Restaurar después de un desastre (procedimiento exacto)

Necesitas: la clave privada de age, acceso a R2 y un proyecto de Supabase **nuevo y vacío** en la misma región que el VPS. Con Postgres 17 y `age` instalados:

```bash
# 1. Elegir el respaldo (el más reciente de 6h/, o uno anterior si el problema es un dato dañado)
aws s3 ls s3://<bucket>/6h/ --endpoint-url https://<account>.r2.cloudflarestorage.com
aws s3 cp s3://<bucket>/6h/aiment-AAAA-MM-DDTHHMMZ.tar.age . --endpoint-url https://<account>.r2.cloudflarestorage.com
# 2. Restaurar en la base nueva (crea el rol app_api, restaura y verifica la integridad)
RESTORE_AUTH=1 scripts/backup/restore.sh aiment-….tar.age ~/clave-age.txt "<url de postgres del proyecto nuevo>"
# 3. Usuario de login de la API (con DATABASE_ADMIN_URL, APP_DB_USER y APP_DB_PASSWORD del nuevo proyecto)
docker run --rm --env-file prod.env <imagen> node dist/roles.js
# 4. Apuntar la API y el worker a la base nueva (variables en EasyPanel) y reiniciarlos
# 5. Comprobar: https://aimentwallet.com/health, una suma en caja y el login del panel
```

- `RESTORE_AUTH=1` restaura los usuarios de login: sin ellos, los dueños quedarían sin su negocio. En la prueba semanal no se usa (la base de prueba no tiene Supabase Auth); solo se comprueba que vengan en el respaldo.
- Los **logos** están en R2 (otro bucket); no forman parte de este respaldo.
- Si el problema es un dato dañado y no una caída, se restaura en una base aparte y se copia solo lo necesario: nunca se pisa producción sin revisarlo.

### Pruebas realizadas

| Fecha      | Dónde                                                                             | Resultado                                                                                                                                                                                            |
| ---------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 09/10/2026 | Local, `pg_dump` a mano                                                           | Filas idénticas, suma de saldos 2706 = 2706, RLS y permisos iguales                                                                                                                                  |
| 17/10/2026 | Local, `backup.sh` → archivo cifrado (276 KB) → `restore.sh` en Postgres 17 vacío | 5 negocios, 89 clientes, 819 movimientos, 7 migraciones; saldos = historial; RLS y permisos intactos. Sin la clave el archivo no se puede leer. La verificación **detecta** un saldo alterado a mano |
| Pendiente  | Producción (Supabase → R2 → base nueva)                                           | **Obligatoria antes del primer negocio real**                                                                                                                                                        |

## 6. Logs

- **Sin tokens ni datos personales.** Las rutas se registran con `:token` en lugar de los secretos de la URL; un error de consulta se registra sin los parámetros SQL ni el `detail` de Postgres (`packages/config/src/log.ts`, con tests).
- Cada error interno lleva el `requestId` de la respuesta: con eso se encuentra en el log sin datos del cliente.
- El worker registra cantidades e ids internos (membresía, negocio), nunca nombres, celulares ni correos.

## 7. Seguridad del despliegue

- **CSP y cabeceras de la PWA:** `apps/web/security-headers.ts`. El build genera `dist/_headers` (Cloudflare Pages/Netlify). Los E2E de CI corren la app con esa política y fallan si el navegador bloquea algo.
- **Dependencias:** CI corre `pnpm audit --audit-level moderate` y `gitleaks` en todo el historial.
- **Límites de intentos:** [ADR 0003](./decisiones/0003-limites-de-intentos.md). En memoria (una instancia); con varias instancias se mueven a Postgres o al borde (deuda #7, semana 9).

## 8. Incidentes frecuentes

| Situación                                 | Qué hacer                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| La caja no tiene internet                 | Por diseño no opera sin conexión ([ADR 0004](./decisiones/0004-caja-requiere-conexion.md)). "Reintentar" no duplica |
| Robaron o perdieron el celular de la caja | Panel → Cajas → **Revocar**. Deja de operar en la siguiente acción                                                  |
| Un trabajador se fue                      | Panel → Equipo → dar de baja (su turno se corta)                                                                    |
| Un cliente perdió su tarjeta              | Caja o panel → QR de recuperación (un solo uso), o recuperación por correo                                          |
| Intentos raros con el PIN del dueño       | Panel → Reportes → "PIN dueño errado" por persona; cambiar el PIN del dueño en Equipo                               |
| Se filtró una clave                       | Rotarla en el proveedor, actualizar el gestor de secretos y redesplegar. `APP_DB_PASSWORD`: `pnpm db:roles`         |

## 9. Google Wallet

- **Modo** (lo muestran la API y el worker al arrancar): `Google Wallet SIMULADO (motivo)` o `Google Wallet REAL (emisor …1234, cuenta@…)`. La API y el worker usan la misma configuración; si uno dice REAL y el otro SIMULADO, revisar el `.env` de cada proceso.
- **Pasar de simulado a real:** poner `GOOGLE_WALLET_ISSUER_ID`, guardar el JSON de la cuenta de servicio en `secrets/google-wallet-sa.json` y usar un `PUBLIC_BASE_URL` https (túnel o dominio). Con `GOOGLE_WALLET_MODE=auto` se activa solo; con `live`, si falta algo, el proceso no arranca y dice qué falta.
- **Botón:** solo en Android. El enlace se arma en la API sin llamar a Google (JWT firmado con la clase y el objeto), así que funciona aunque la API de Google esté caída.
- **Si Google falla:** la caja y el ledger no se enteran. El worker reintenta (cola `wallet.sync.google`, 8 intentos con espera creciente hasta 1 h). Los rechazos por datos o permisos (400/403, credenciales inválidas) **no se reintentan**: quedan en `wallet_passes.last_error`.
  ```sql
  select external_id, last_error, last_synced_at from app.wallet_passes
  where provider = 'google' and last_error is not null order by updated_at desc limit 20;
  ```
- **Cambios del dueño (bloque 2):** nombre, color o logo (`organization.branding_updated`) y nombre, unidad, regla o meta del programa (`program.updated`) actualizan la clase de Google y reenvían cada pase activo del programa (un job por pase, con debounce). Con muchos pases, el reenvío tarda unos minutos.
- **Mensajes automáticos:** el pase muestra el mismo mensaje vigente que la tarjeta web. "Meta cumplida" llega además como notificación al celular, una sola vez por mensaje (Google limita a 3 notificaciones por pase cada 24 h).
- **Reenviar un pase:** insertar un evento `wallet.resync_requested` para la membresía (el worker manda el estado actual).
- **Baja de un cliente:** sus pases pasan a `revoked` y el worker los deja inactivos en Google, sin nombre ni QR.

## 10. Producción: VPS, Cloudflare y Supabase (aprobado el 17/10/2026)

Costo fijo mínimo para el piloto: VPS que el fundador ya tenía, planes gratis de Cloudflare, Supabase y Resend. Se escala cuando las métricas lo piden (tabla de abajo).

| Pieza                                         | Dónde                                                            | Notas                                                                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| PWA (tarjeta, caja, panel) y redirector `/go` | Cloudflare (gratis), `aimentwallet.com`                          | Las rutas `/v1`, `/go`, `/health` y `/auth/v1` se reenvían al origen: web y API en el mismo dominio (cookies de caja y CSP) |
| API y worker                                  | VPS Hostinger KVM 2 (Boston: 2 vCPU, 8 GB, 100 GB) con EasyPanel | Contenedores separados de n8n y Evolution API, con límite de memoria                                                        |
| Entrada al VPS                                | **Cloudflare Tunnel** (contenedor `cloudflared`)                 | La API no publica puertos; n8n y WhatsApp siguen por Traefik                                                                |
| Base y login                                  | Supabase Free, `us-east-1`                                       | 18–60 ms desde el VPS (São Paulo: 128 ms). Segundo proyecto gratis = staging                                                |
| Archivos y respaldos                          | Cloudflare R2 (gratis hasta 10 GB)                               | Buckets separados: archivos y respaldos                                                                                     |
| Correo                                        | Resend (gratis: 3.000/mes, 100/día)                              | Dominio verificado con DNS en Cloudflare                                                                                    |

### Imagen y servicios

Una imagen (`Dockerfile`, ~370 MB, usuario sin privilegios) para todo:

| Servicio en EasyPanel      | Comando                                                                 | Límite de memoria |
| -------------------------- | ----------------------------------------------------------------------- | ----------------- |
| `aiment-api`               | `node --enable-source-maps dist/api.js` (puerto 8787, solo red interna) | 512 MB            |
| `aiment-worker`            | `node --enable-source-maps dist/worker.js`                              | 384 MB            |
| Migraciones (al desplegar) | `node dist/migrate.js` y, la primera vez, `node dist/roles.js`          | —                 |
| `cloudflared`              | Túnel hacia `aiment-api:8787`                                           | 128 MB            |

Orden de un despliegue: 1) respaldo manual (`Run workflow` en GitHub), 2) migraciones, 3) API y worker nuevos. Se despliega de noche: reiniciar la API corta la caja unos segundos.

Las claves (Supabase, R2, Resend, Google, Apple) las carga el fundador en las variables de EasyPanel; no pasan por el repositorio ni por el chat.

### Seguridad del VPS

| Medida                                                                                                                                                                                                                                                                                                                                                                    | Estado (17/10/2026)                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Swap de 2 GB (`vm.swappiness=10`)                                                                                                                                                                                                                                                                                                                                         | Hecho                                      |
| Usuario `aiment` con llave SSH y sudo; llave dedicada revocable en hPanel                                                                                                                                                                                                                                                                                                 | Hecho                                      |
| SSH sin contraseñas; `root` bloqueado desde internet y permitido solo con llave desde la red interna de Hostinger (169.254.0.0/16), por donde entra la consola web de hPanel (respaldo de acceso). Configuración: `/etc/ssh/sshd_config.d/00-aiment-hardening.conf` y bloque `Match` al final de `/etc/ssh/sshd_config` (copia previa: `sshd_config.bak-aiment-20261017`) | Hecho y probado (17/10/2026)               |
| Firewall de Hostinger (entrada solo 22, 80, 443): cierra el panel en 3000 y los puertos de Docker Swarm (2377, 7946)                                                                                                                                                                                                                                                      | Pendiente: lo activa el fundador en hPanel |
| EasyPanel en `https://8txaub.easypanel.host` con contraseña fuerte y verificación en dos pasos                                                                                                                                                                                                                                                                            | Pendiente: verificar                       |
| Actualizaciones automáticas de seguridad                                                                                                                                                                                                                                                                                                                                  | Activas                                    |

### Monitoreo y avisos

Los avisos salen por correo (`ALERT_EMAIL`) y/o webhook (`ALERT_WEBHOOK_URL`, p. ej. un flujo de n8n que reenvía a WhatsApp). El mismo aviso no se repite antes de 6 h; si el problema se resuelve, el siguiente sale de inmediato.

| Métrica                               | Quién mide                                                           | Aviso                            | Acción                                                                                                    |
| ------------------------------------- | -------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Tamaño de la base                     | worker, cada 15 min                                                  | 300 MB; crítico 400 MB           | Pasar a Supabase Pro antes de 400 MB (a 500 MB el plan gratis queda **en solo lectura**: la caja no suma) |
| RAM del servidor                      | worker                                                               | 75%                              | Revisar n8n/WhatsApp; subir de plan si se sostiene                                                        |
| Disco                                 | worker                                                               | 70%                              | Limpiar imágenes viejas (`docker image prune`); subir de plan                                             |
| Carga (5 min, por núcleo)             | worker                                                               | 0,75 (≈ 1,5 en 2 núcleos)        | Ver quién consume; subir de plan si se sostiene                                                           |
| Caja: p95 de respuesta                | API, cada minuto (últimos 15 min)                                    | > 1,5 s con 20+ operaciones      | Ver base (latencia) y CPU                                                                                 |
| Caja: errores 5xx                     | API                                                                  | 10 en 15 min (crítico)           | Logs de la API                                                                                            |
| Eventos sin procesar                  | worker                                                               | 10 min                           | El worker está caído o trabado                                                                            |
| Pases de Wallet con error             | worker                                                               | 20                               | `wallet_passes.last_error` (sección 9)                                                                    |
| Respaldo y prueba de restauración     | GitHub Actions                                                       | Cualquier fallo                  | Sección 5                                                                                                 |
| Transferencia de Supabase y uso de R2 | Revisión semanal en sus paneles                                      | Supabase > 3,5 GB/mes; R2 > 7 GB | Pasar a Pro / revisar retención                                                                           |
| Servidor caído                        | Monitor externo (UptimeRobot o Better Stack, gratis) sobre `/health` | Sin respuesta 2 veces            | Consola web de hPanel                                                                                     |

### Cuándo escalar (sin rehacer la arquitectura)

| Cambio                          | Cuándo                                                                                                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Supabase Free → Pro (US$25/mes) | Base > 300 MB y antes de 400 MB; transferencia > 3,5 GB/mes; o 3+ negocios pagando                                                     |
| KVM 2 → más recursos            | RAM > 75% o carga > 1,5 sostenida 15 min; disco > 70%                                                                                  |
| KVM → Railway u otro            | Caídas repetidas del VPS, o si mantenerlo quita tiempo                                                                                 |
| Un servidor → varios            | Caja lenta con la CPU al tope, o se necesita que la caja nunca se corte. Antes: mover el límite de intentos (hoy en memoria) a la base |

### Pendiente legal formal

Los datos personales quedan fuera de Perú (Supabase en Estados Unidos, VPS en Boston). El cumplimiento de la **transferencia internacional** (Ley 29733 y su reglamento) se resuelve formalmente **antes de cargar datos reales**; no alcanza con un aviso.
