# Runbook de Aiment Wallet

Cómo se opera el sistema: qué corre, qué variables necesita, cómo se migra la base y cómo se hace (y se restaura) un respaldo. Vale para local hoy y es la base de staging y producción (semana 9).

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

| Variable                                                | Para qué                                                                                              | Producción                                     |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `DATABASE_ADMIN_URL`                                    | Migraciones y seed (dueño del esquema). **Nunca** la usa la API                                       | Solo en el paso de despliegue                  |
| `DATABASE_URL`, `APP_DB_USER`, `APP_DB_PASSWORD`        | API y worker: usuario miembro de `app_api`, **sin BYPASSRLS**                                         | Clave larga y única, en el gestor de secretos  |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`              | Login del panel                                                                                       | Proyecto de Supabase                           |
| `SUPABASE_SECRET_KEY`                                   | Invitaciones de dueños (solo servidor)                                                                | Secreto                                        |
| `SUPABASE_JWT_SECRET`                                   | Solo local/legacy (HS256)                                                                             | Vacío: la API valida con JWKS                  |
| `AUTH_REQUIRE_SUPERADMIN_MFA`                           | Superadmin con TOTP                                                                                   | `true`                                         |
| `PUBLIC_BASE_URL`                                       | Enlaces que salen del sistema (correos, QR, PDF de mostrador)                                         | `https://{dominio}`                            |
| `TRUST_PROXY`                                           | IP real desde `X-Forwarded-For`                                                                       | `true` detrás de Cloudflare                    |
| `VISITOR_HASH_SALT`                                     | Hash diario de visitantes (no se guarda la IP)                                                        | Aleatorio, 32+ caracteres                      |
| `RATE_LIMIT_*`                                          | Suben los límites por IP para probar en local                                                         | **Vacías** (valores por defecto, ver ADR 0003) |
| `MAIL_TRANSPORT`, `SMTP_*`, `MAIL_FROM`                 | Correo                                                                                                | Proveedor transaccional por SMTP               |
| `STORAGE_DIR`                                           | Carpeta de logos                                                                                      | Se reemplaza por R2 (semana 9)                 |
| `GOOGLE_WALLET_MODE`                                    | Google Wallet: `auto` (real si hay credenciales y https; si no, simulado), `simulated`, `live`, `off` | `live` (no arranca si falta algo)              |
| `GOOGLE_WALLET_ISSUER_ID`, `GOOGLE_WALLET_SA_JSON_PATH` | Cuenta emisora y cuenta de servicio de Google Wallet                                                  | Archivo en `secrets/` (nunca en git)           |

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

| Trabajo          | Cuándo                                                                     | Qué hace                                                                                                            |
| ---------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `loyalty.expire` | Cada hora (minuto 7, UTC). Cada negocio, a las **3:00 de su zona horaria** | Vence premios con vigencia y, si el negocio lo configuró, saldos inactivos (en el piloto: desactivado). Idempotente |
| Outbox           | Cada segundo                                                               | Encola la sincronización de pases de Wallet (una cola por proveedor, con reintentos)                                |

Si el worker estuvo caído, al volver el siguiente trabajo horario procesa a los negocios que estén a las 3:00; los que se saltaron se ponen al día al día siguiente (el vencimiento compara contra la fecha, no contra la hora del trabajo).

## 5. Respaldo y restauración

### Respaldo (probado el 09/10/2026 en local)

```bash
# Esquemas de la aplicación: datos, historial de migraciones y colas.
docker exec supabase_db_aiment-wallet \
  pg_dump -U postgres -d postgres --schema=app --schema=drizzle --schema=pgboss -Fc -f /tmp/aiment.dump
docker cp supabase_db_aiment-wallet:/tmp/aiment.dump ./aiment-$(date +%F).dump
```

En otro servidor, lo mismo sin `docker exec`: `pg_dump "$DATABASE_ADMIN_URL" --schema=app --schema=drizzle --schema=pgboss -Fc -f aiment.dump`.

- Los **usuarios de Supabase Auth** (esquema `auth`) los respalda Supabase. Los **logos** se respaldan aparte (`STORAGE_DIR`, o el bucket de R2 en producción).
- El archivo tiene **datos personales**: se guarda cifrado y fuera del repositorio. En local solo hay datos ficticios.
- **Producción (semana 9):** respaldo diario del proveedor (con PITR si el plan lo permite) **más** este `pg_dump` diario a un bucket distinto, con retención de 30 días. Probar una restauración al menos una vez al mes.

### Restauración

```bash
# 1. Base vacía y roles (en un servidor nuevo, antes de restaurar):
psql "$DATABASE_ADMIN_URL" -c "CREATE ROLE app_api NOLOGIN NOBYPASSRLS;"
pnpm db:roles
# 2. Restaurar:
pg_restore -d "$DATABASE_ADMIN_URL" --exit-on-error aiment.dump
# 3. Verificar:
pnpm db:migrate   # no debe aplicar nada nuevo si el respaldo es de la misma versión
curl -s https://{dominio}/health
```

### Resultado de la prueba (local, 09/10/2026)

Respaldo de 310 KB en 0,2 s y restauración en una base nueva del mismo servidor:

| Comprobación                                                                                             | Resultado                                                                     |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Filas en clientes, membresías, ledger, premios, canjes, auditoría, automatizaciones, migraciones y colas | **Idénticas** al origen                                                       |
| Suma de todos los saldos                                                                                 | 2706 = 2706                                                                   |
| Tablas con RLS forzado                                                                                   | 28 de 32 en ambas (las 4 restantes son globales: `plans`, `users`, `apple_*`) |
| Usuario de la API sin negocio / como Barbería / clientes de otro negocio                                 | 0 / 86 / 0                                                                    |
| El usuario de la API intenta borrar el ledger                                                            | `permission denied`                                                           |
| Un administrador intenta editar el ledger                                                                | "es inmutable" (trigger)                                                      |

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
- **Reenviar un pase:** insertar un evento `wallet.resync_requested` para la membresía (el worker manda el estado actual).
- **Baja de un cliente:** sus pases pasan a `revoked` y el worker los deja inactivos en Google, sin nombre ni QR.
