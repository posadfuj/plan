# Aiment Wallet: arquitectura v1.0

Estado: **cerrada para el MVP** · Fecha: 28/09/2026
Base: *Plan Maestro v0.1*, *Revisión técnica v0.1* y *Respuesta a revisión técnica v1.0*.
Complementos: [`esquema-v1.0.sql`](./esquema-v1.0.sql) (modelo de datos validado en PostgreSQL 16) y [`backlog-mvp.md`](./backlog-mvp.md).

> Regla madre: **PostgreSQL + ledger son la fuente de verdad.** La tarjeta web, Apple Wallet y Google Wallet son vistas sincronizadas del mismo estado. Si una sincronización falla, el saldo y el canje siguen siendo válidos.

---

## 1. Resumen de decisiones

| Tema | Decisión v1.0 |
|---|---|
| Marca | Aiment Wallet. Jerarquía: comercio → programa → "Powered by Aiment Wallet" (discreto y constante). |
| Backend | Node.js 22 + TypeScript + Hono + Drizzle. API y worker en el mismo repositorio, desplegados como 2 procesos. |
| Frontend | React + Vite + TanStack Router/Query + Tailwind + shadcn/ui, como PWA. Una app con 4 superficies. |
| Base de datos | Supabase Pro (PostgreSQL). Esquema `app` **no expuesto** por la Data API. RLS como segunda capa. |
| Auth | Supabase Auth para dueños, admins y superadmin. **Dispositivo autorizado + PIN** para trabajadores. |
| Jobs | Tabla `event_outbox` + dispatcher → **pg-boss** (sobre el mismo Postgres). |
| Edge | Cloudflare: DNS, Worker redirector + KV (dominio corto), Turnstile y R2 (imágenes públicas de pases). |
| Wallet | Apple Store Card + Google Loyalty, con una sola cuenta emisora de Aiment Wallet. |
| Canal universal | Tarjeta web obligatoria. |
| Captación | QR + NFC pasivo → misma URL corta por sucursal, con `?c=q` / `?c=n`. No acreditan puntos. |
| Motor | Un solo ledger para sellos y puntos. La regla genera el delta. |
| Verificación de celular | No en el MVP. El beneficio de bienvenida se acredita en la 1.ª visita validada por un trabajador. |
| Expiración | Por inactividad y configurable. Valor por defecto: 12 meses. **Desactivada en el piloto** (`expiration_months = null`). |
| Fuera del MVP | POS, app nativa, cobro autoservicio, SUNAT, WhatsApp, editor avanzado, multi-sucursal con reglas distintas, NFC dinámico, white-label. |

---

## 2. Vista de componentes

```
                         ┌─────────────────────────── Cloudflare ───────────────────────────┐
  QR / NFC mostrador ──► │  aim.xx/X8P2K?c=n ─► Worker redirector (KV: slug → destino)      │
                         │  Turnstile (registro) · R2 público: logos, strips de sellos       │
                         └───────────────────────────────┬───────────────────────────────────┘
                                                         │ 302
                                                         ▼
 ┌──────────────── app.aimentwallet.xx (React PWA) ───────────────┐
 │  /r/:slug        Landing de registro del comercio              │
 │  /c/:cardToken   Tarjeta web del cliente                       │
 │  /caja           Modo trabajador (escáner)                     │──────┐
 │  /panel          Panel del dueño                               │      │ HTTPS JSON
 │  /admin          Superadmin                                    │      │
 └────────────────────────────────────────────────────────────────┘      ▼
                                              ┌──────────── api.aimentwallet.xx ─────────────┐
 Apple Wallet (dispositivos) ───────────────► │  API Node (Hono)                             │
   /v1/devices/... /v1/passes/... /v1/log     │  - authz: tenant, rol, dispositivo, PIN      │
                                              │  - motor de fidelización (transacciones)     │
                                              │  - servicio web de Apple Wallet              │
                                              │  - emisión .pkpass / JWT Google              │
                                              └───────────────┬──────────────────────────────┘
                                                              │ pool (pooler Supabase, modo sesión)
                                                              ▼
                                              ┌────────── Supabase Postgres ─────────────────┐
                                              │  esquema app · RLS · ledger inmutable        │
                                              │  event_outbox · pg-boss (esquema pgboss)     │
                                              └───────────────┬──────────────────────────────┘
                                                              │
                                              ┌───────────────▼──────────────────────────────┐
                                              │  Worker Node (mismo código, otro proceso)    │
                                              │  dispatcher outbox → colas pg-boss:          │
                                              │   wallet.apple.push · wallet.google.patch    │
                                              │   automation.run · link.sync · cron diarios  │
                                              └──┬──────────────┬──────────────┬─────────────┘
                                                 ▼              ▼              ▼
                                           APNs (HTTP/2)   Google Wallet    Resend (correo)
                                                           REST API
```

### 2.1 Hosting y región

**Regla:** la API y la base deben estar **en la misma región**, porque cada operación de caja hace varias consultas.

| Opción | Base | API + worker | Nota |
|---|---|---|---|
| **A (recomendada)** | Supabase `us-east-1` | **Railway** US East | La más simple de operar. Latencia Lima–Virginia ~100–130 ms, aceptable para caja. |
| B | Supabase `sa-east-1` (São Paulo) | Fly.io `gru` | Algo más cerca de Perú; Fly requiere algo más de configuración. |

Con cualquiera de las dos, la política de privacidad debe informar el **flujo transfronterizo** de datos (servidores fuera de Perú), según la Ley 29733. **[confirmar con asesor legal]**

### 2.2 Dominios (nombres pendientes de disponibilidad)

| Uso | Ejemplo | Regla |
|---|---|---|
| Plataforma | `aimentwallet.com` → `app.`, `api.`, `www.` | Renovación automática. |
| Corto (impreso) | `aim.pe` / `aimw.io` o similar | **Infraestructura crítica.** Comprar por 5–10 años, con renovación automática, alerta de vencimiento y DNSSEC. Solo lo sirve el Worker redirector. |

---

## 3. Estructura del repositorio

```
aiment-wallet/
├─ apps/
│  ├─ web/                 React PWA (registro, tarjeta, caja, panel, admin)
│  ├─ api/                 Hono: rutas HTTP + servicio web Apple
│  ├─ worker/              dispatcher del outbox + consumidores pg-boss + crons
│  └─ edge-redirect/       Cloudflare Worker (slug → destino, registra visita)
├─ packages/
│  ├─ core/                motor de fidelización PURO (reglas, límites, cálculo) + tests
│  ├─ db/                  esquema Drizzle, migraciones, repositorios con tenant obligatorio
│  ├─ wallet/              WalletProvider { issue, update, revoke } + apple/ + google/
│  ├─ contracts/           esquemas Zod compartidos (requests/responses)
│  └─ ui/                  componentes compartidos
├─ e2e/                    Playwright
└─ docs/
```

**Regla de dependencias:** `core` no importa nada de `db`, `wallet` ni HTTP. Toda la lógica de negocio se puede probar sin base ni red.

---

## 4. Identidad, autenticación y autorización

### 4.1 Actores y cómo se autentican

| Actor | Mecanismo | Sesión |
|---|---|---|
| Superadmin | Supabase Auth (correo + contraseña **y TOTP obligatorio**) | JWT Supabase verificado por la API (`users.is_superadmin`) |
| Dueño / admin | Supabase Auth (correo + contraseña o magic link) | JWT Supabase → la API resuelve `organization_users` |
| Dispositivo de caja | El dueño lo autoriza desde el panel (código QR de 10 min) → se emite un `device_secret` | Cookie `httpOnly`, `Secure`, `SameSite=Strict`, válida 180 días y revocable |
| Trabajador | En un dispositivo autorizado: elige su nombre + PIN de 4–6 dígitos | `staff_session` de 12 h (o hasta cerrar turno), revocable |
| Cliente final | Sin cuenta. Posee `card_token` (URL secreta de la tarjeta web) | — |
| Apple Wallet | `Authorization: ApplePass <authenticationToken>` por pase | Por solicitud |

**PIN:** hash argon2id. Tras 5 intentos fallidos, bloqueo de 15 minutos por trabajador y alerta al dueño. El PIN nunca sirve fuera de un dispositivo autorizado.

### 4.2 Autorización en la API (primera capa)

Cada request pasa por un middleware que construye un `AuthContext`:

```ts
type AuthContext =
  | { kind: 'superadmin'; userId: string; supportOrgId?: string }
  | { kind: 'member'; orgId: string; orgUserId: string; role: 'owner' | 'admin' }
  | { kind: 'staff'; orgId: string; orgUserId: string; deviceId: string; branchId: string }
  | { kind: 'card'; orgId: string; membershipId: string }        // tarjeta web
  | { kind: 'system' };                                         // worker / Apple web service
```

- Los repositorios de `packages/db` **exigen** `orgId` como primer parámetro; no existe una función "buscar membresía por id" sin tenant.
- Permisos por rol en una matriz declarativa (`can(ctx, 'ledger.adjust')`).

### 4.3 RLS (segunda capa)

- La API se conecta con el rol `app_api` (sin `BYPASSRLS`).
- Cada transacción empieza con `set_config('app.org_id', …, true)`. Los procesos de sistema usan `set_config('app.scope','system', true)`.
- `ledger_entries` y `audit_logs`: `app_api` **no tiene permiso** de `UPDATE`/`DELETE`, y además hay un trigger que lo impide. Esto está probado en el esquema.
- Test de CI obligatorio: con `app.org_id = B`, ninguna consulta devuelve ni escribe datos de A.

---

## 5. Motor de fidelización

### 5.1 Conceptos

| Concepto | Stamps (sellos) | Points (puntos) |
|---|---|---|
| Regla de acumulación | `per_visit` → +N unidades | `per_amount` → `floor(importe / amount_per_unit)` |
| Meta | `goal` (p. ej. 10) → al llegar se crea un `earned_reward` y un `convert` de −goal | No hay meta única; hay un catálogo de `rewards` con `cost` |
| Canje | Consume un `earned_reward` disponible | Movimiento `redeem` de −cost + `redemption` |
| "Te falta 1" | `goal − balance == 1` | `min(cost) − balance` ≤ umbral configurable |

Los sellos que sobran se arrastran: si la meta es 10 y el cliente tiene 9 + 2, recibe 1 premio y le quedan 1 sello.

### 5.2 Operaciones de caja (API)

Todas reciben un `Idempotency-Key` (UUID generado en el navegador **por intención**, no por clic) y se ejecutan en **una sola transacción**:

```
POST /v1/staff/memberships/:token/earn      { amount?, note? }
POST /v1/staff/memberships/:token/redeem    { earnedRewardId? | rewardId? }
POST /v1/staff/ledger/:entryId/void         { reason }
GET  /v1/staff/memberships/:token           → nombre, saldo, premios, últimos movimientos
GET  /v1/staff/memberships?phone=…|code=…   → búsqueda (máx. 5 resultados, datos mínimos)
```

Secuencia de `earn`:

1. Verificar si la `idempotency_key` ya existe → **devolver el resultado original** (reintento seguro).
2. `SELECT … FROM memberships WHERE member_token = $1 AND organization_id = $org FOR UPDATE`.
3. Cargar `rule_version` actual y ejecutar `core.computeEarn(rule, input, context)`.
4. Validar límites (sección 5.4). Si fallan → `409` con código legible para la caja.
5. `INSERT ledger_entries (earn)` con `balance_after`.
6. Si es la **1.ª visita validada** (`first_validated_at is null`), aplicar `welcome_bonus` (`bonus` o `earned_reward` de tipo gift) y marcar `first_validated_at`.
7. Si modo stamps y `balance ≥ goal` → repetir: `INSERT earned_rewards` + `INSERT ledger (convert, −goal)`.
8. `UPDATE memberships SET balance, lifetime_earned, last_activity_at, version = version + 1`.
9. `INSERT event_outbox ('ledger.created', …)` y, si corresponde, `('reward.earned', …)`.
10. `INSERT audit_logs` solo para acciones sensibles (ajuste, anulación, override de límite).
11. `COMMIT` → responder a la caja con el nuevo estado **desde la base**, no desde Wallet.

### 5.3 Anulación

- **Trabajador:** solo su **último** movimiento, dentro de **15 minutos**, con motivo.
- **Dueño/admin:** cualquier movimiento, con motivo obligatorio y registro en auditoría.
- Anular un `earn` que generó un premio:
  - si el premio sigue `available` → se anula (`voided`) junto con su `convert`;
  - si ya fue canjeado → **bloqueado** (hay que anular primero el canje, y eso solo lo puede hacer el dueño).
- Nunca se anula dos veces: índice único en `reverses_entry_id`.

### 5.4 Límites anti-fraude (configurables por versión de regla)

| Límite | Valor por defecto |
|---|---|
| `cooldown_minutes` por membresía (stamps) | 240 (1 sello cada 4 h) |
| `max_units_per_tx` | 1 (stamps) / sin tope (points) |
| `max_amount_per_tx` (points) | S/ 500 |
| `staff_daily_units` por trabajador | 200 |

Si un límite se supera, la caja muestra el motivo y permite **"Autorizar con PIN de dueño/admin"**. El override queda en `audit_logs`.

Reporte "Actividad por trabajador" en el panel: movimientos, anulaciones y overrides por día.

### 5.5 Expiración

Job diario por organización (a las 03:00 de su zona horaria): membresías con `balance > 0` y `last_activity_at < now() − expiration_months` → movimiento `expire` por el saldo total. Con `expiration_months = null` no hace nada (modo piloto). Los `earned_rewards` vencen por `expires_at`.

---

## 6. Flujo del cliente

### 6.1 Registro (QR/NFC → tarjeta)

1. `aim.xx/X8P2K?c=q` → el Worker busca el slug en KV, registra la visita (asíncrono, `waitUntil`) y responde `302 → app…/r/X8P2K?c=q&v=<visitId>`.
2. La landing muestra la marca del comercio, el beneficio, el formulario (nombre, celular; correo y cumpleaños opcionales, cada uno con su finalidad explicada), la aceptación de términos + privacidad y el **check separado** de marketing. Turnstile invisible.
3. `POST /v1/public/register`:
   - Si el **celular es nuevo** → crea `customer` + `consents` + `membership` (`member_token`, `card_token` y `short_code`) → responde con el `card_token`.
   - Si el **celular ya existe** en ese negocio → **no revela datos**. Responde: *"Ya tienes una tarjeta. Pídela en caja o recupérala por correo"*.
4. Redirige a `/c/:cardToken`. El `card_token` se guarda en `localStorage`, de modo que si vuelve a escanear el QR del local, la landing ofrece "Abrir mi tarjeta".
5. La tarjeta web ofrece **Agregar a Apple Wallet** (en iOS/Safari) o **Agregar a Google Wallet** (en Android), según `User-Agent`, con opción de ver ambos.

### 6.2 Tarjeta web `/c/:cardToken`

Muestra: comercio, programa, saldo, progreso visual, premios disponibles, próximo premio, **QR individual**, `short_code`, botones de Wallet, historial básico (últimos 10 movimientos) y el pie "Powered by Aiment Wallet".
Cabeceras: `Referrer-Policy: no-referrer`, `noindex`. El `card_token` nunca aparece en logs.

### 6.3 QR del cliente (tarjeta web y pases)

- Contenido: `https://aim.xx/m/<member_token>`.
  - Si lo escanea la **caja**, el escáner extrae el token y llama a la API.
  - Si lo escanea **cualquier otra cámara**, la página muestra solo *"Presenta este código en caja de {Comercio}"*, sin nombre ni saldo. Una captura del QR no expone datos.
- `member_token` ≠ `card_token`: tener el QR no da acceso a la tarjeta web.

### 6.4 Recuperar la tarjeta (sin OTP)

Buscar solo por celular filtraría tarjetas de otras personas, así que se ofrecen dos vías seguras:

1. **Por correo** (si lo dio): *"Envíame mi tarjeta"* → enlace de un solo uso con 30 minutos de vigencia. La respuesta es siempre la misma, exista o no el correo.
2. **En caja:** el trabajador busca por celular, verifica a la persona y toca *"Mostrar QR de recuperación"*. El cliente lo escanea y se abre su tarjeta (token de un solo uso de 10 minutos, auditado).
3. *(Fase 2)* Por WhatsApp.

Si hace falta, el dueño puede **rotar** el `card_token` desde el panel, lo que invalida el enlace anterior.

---

## 7. Wallet

### 7.1 Interfaz común

```ts
interface WalletProvider {
  issue(m: MembershipView): Promise<IssueResult>;   // Apple: .pkpass | Google: URL "Save to Wallet"
  update(m: MembershipView): Promise<void>;
  revoke(m: MembershipView): Promise<void>;
}
```

`MembershipView` es una proyección de solo lectura (marca, programa, saldo, premios, mensajes). Los proveedores **no** tocan el ledger.

### 7.2 Apple (Store Card)

- **Un** Pass Type ID de Aiment Wallet (`pass.com.aimentwallet.loyalty`). Mismo certificado en staging y producción; cada pase trae su propio `webServiceURL` (staging o prod).
- Contenido del pase:
  - `organizationName` y `logoText` = comercio;
  - `primaryFields` = saldo (sellos/puntos);
  - `secondaryFields` = próximo premio;
  - `auxiliaryFields` = "Te falta 1" / premio disponible;
  - `backFields` = condiciones, contacto, enlace a la tarjeta web y **"Powered by Aiment Wallet"**;
  - `barcodes` = QR con la URL `/m/<member_token>` y `altText = short_code`;
  - `locations` = sucursales (hasta 10).
- **Imagen strip de sellos:** se genera con `sharp` por `(program design hash, count, goal)`, se guarda en R2 y se reutiliza. Así 1.000 clientes con 7/10 comparten la misma imagen.
- **Servicio web:** 5 endpoints (`register`, `unregister`, `serials?passesUpdatedSince`, `latest pass` con `If-Modified-Since`, `log`), autenticados con `authenticationToken` comparado contra `auth_token_hash`.
- **Push:** cliente APNs HTTP/2 persistente (`node:http2`) con el certificado del Pass Type ID y `apns-topic = passTypeIdentifier`. Si APNs responde `410`, se elimina el registro del dispositivo.
- `changeMessage` solo en saldo y premio (p. ej. *"¡Tienes %@ sellos!"*), para no generar ruido.

### 7.3 Google (Loyalty)

- **Una** cuenta issuer de Aiment Wallet, con una `LoyaltyClass` por programa (`<issuerId>.aw_<programId>`) y un `LoyaltyObject` por membresía (`<issuerId>.aw_<membershipId>`).
- `issuerName` y `programName` = comercio/programa; `programLogo` = logo (R2); `hexBackgroundColor`; `heroImage` = strip de sellos (misma caché); `loyaltyPoints.balance`; `barcode` = QR `/m/<member_token>`; `linksModuleData` = tarjeta web + "Powered by Aiment Wallet".
- Emisión: JWT firmado con la cuenta de servicio → `https://pay.google.com/gp/v/save/<jwt>`. La clase se crea o actualiza **antes** de la primera emisión.
- Actualización: `PATCH loyaltyObject`. Los mensajes con notificación (`addMessage`) solo para premio alcanzado, respetando el límite diario de Google.

### 7.4 Sincronización y resiliencia

- El dispatcher lee `event_outbox` pendiente cada 1 s (o con `LISTEN/NOTIFY`) y lo encola en pg-boss.
- Colas `wallet.apple.update` y `wallet.google.update` con `singletonKey = membershipId` y un *debounce* de ~3 s: si la caja suma 3 veces seguidas, se hace **una** sola sincronización con el estado final.
- Reintentos con *backoff* exponencial (hasta 24 h). Tras agotarlos, queda `wallet_passes.last_error` + alerta en Sentry. El saldo **no se ve afectado**.
- Si un proveedor está caído, la caja y la tarjeta web siguen funcionando con normalidad.

### 7.5 Secretos

| Secreto | Dónde | Rotación |
|---|---|---|
| Certificado Pass Type ID (`.p12`) + contraseña | Variables de entorno del host (cifradas), en base64 | Anual. Alertas a 60/30/7 días (job diario que lee la fecha `notAfter`). |
| Certificado WWDR de Apple | Repositorio (es público) | Cuando Apple lo renueve. |
| JSON de la cuenta de servicio de Google | Variables de entorno | Anual, o si hay sospecha de fuga. |
| `DATABASE_URL` (rol `app_api`) | Variables de entorno | Semestral. |
| Supabase `service_role` | **No se usa en la API.** Solo en scripts de administración. | — |

---

## 8. URLs cortas y material físico

- Slug de 5–6 caracteres de un alfabeto sin ambiguos (`23456789ABCDEFGHJKMNPQRSTUVWXYZ`).
- **Una URL por sucursal** (`kind = registration`). Las campañas (fase 2) usan otras URLs.
- Cualquier cambio de `short_links` pasa por la API → `event_outbox (link.changed)` → el worker actualiza Cloudflare KV. KV es una caché: si un slug no está, el Worker consulta `GET api/v1/public/links/:slug`.
- Entregables por sucursal en el panel:
  - QR en SVG/PNG;
  - PDF imprimible de mostrador con la marca del comercio y "Powered by Aiment Wallet" en la base;
  - URL NFC (`…?c=n`).
- **Grabado de NFC** (NTAG213/215, NDEF URI): grabar → probar en iPhone y Android → **bloquear** → registrar en `physical_tags` (`nfc_uid`, `locked = true`).

---

## 9. Automatizaciones del MVP

| Clave | Disparo | Acción |
|---|---|---|
| `welcome` | 1.ª visita validada (síncrono, dentro de la transacción de `earn`) | Bono de unidades o premio de regalo, según la regla. Mensaje en la tarjeta: "¡Bienvenido!". |
| `goal_reached` | `reward.earned` (outbox) | Actualizar pase con notificación ("¡Ganaste {premio}!"). |
| `almost_there` | `ledger.created` cuando falta 1 (o el umbral) | Mensaje en el pase y en la tarjeta, sin notificación push. |

Cada ejecución registra un `automation_runs.idempotency_key` (p. ej. `goal_reached:<earnedRewardId>`), por lo que nunca se duplica. El dueño puede apagar cada automatización. El motor ya admite `birthday` e `inactivity` como crons (fase 2) sin cambiar el núcleo.

---

## 10. Datos personales y retención (propuesta de valores por defecto)

| Dato | Retención | Al terminar |
|---|---|---|
| Cliente activo | Mientras exista la membresía | — |
| Baja solicitada por el cliente | Se atiende en ≤ 10 días hábiles **[confirmar plazo legal]** | **Anonimización**: se borran nombre, celular, correo y cumpleaños; el ledger se conserva sin datos personales (`customers.status = anonymized`) |
| Cliente sin actividad | 24 meses sin movimientos | Anonimización automática (configurable) |
| Negocio que cancela | 90 días para exportar (CSV) | Anonimización de clientes; ledger agregado para facturación |
| `channel_visits` | 13 meses | Borrado |
| `audit_logs` | 24 meses | Borrado |
| Backups de Supabase | 7 días (plan Pro) | Rotación automática |

Documentos legales (fase 0, con abogado): términos para comercios con **contrato de encargo de tratamiento**, plantilla de términos y privacidad para clientes finales (versionada en `consent_versions`), procedimiento de derechos ARCO y evaluación de inscripción de bancos de datos ante la ANPD.

---

## 11. Seguridad transversal

- Solo HTTPS, con HSTS. CORS restringido a `app.` y `www.`. CSP estricta en la PWA.
- La API usa `Authorization: Bearer` para paneles (sin riesgo CSRF). La cookie del dispositivo usa `SameSite=Strict` + cabecera `X-Requested-With` obligatoria.
- Rate limits (en memoria por instancia + Postgres para los críticos):
  - registro: 5 por IP cada 10 minutos + Turnstile;
  - PIN: 5 intentos;
  - búsqueda por celular: 30 por minuto y por dispositivo;
  - recuperación por correo: 3 por hora.
- Tokens: `crypto.randomBytes(16)` en base62; nunca IDs secuenciales en URLs.
- **Modo soporte del superadmin** (fase 2): `supportOrgId` con motivo obligatorio y registro en auditoría. En el MVP, el superadmin opera con su propio rol y todo queda auditado.
- Dependencias: Renovate + `pnpm audit` en CI.

---

## 12. Observabilidad y operación

| Qué | Herramienta | Alerta |
|---|---|---|
| Errores front y back | Sentry | Nuevo error en producción |
| Uptime de `api`, `app` y dominio corto | Better Stack / UptimeRobot | Caída > 1 min |
| Lag del outbox | Métrica propia (`/health/outbox`) | Pendientes con más de 5 min |
| Fallos de Wallet | `wallet_passes.last_error` + Sentry | > 5 % de fallos en 1 h |
| Certificado Apple y dominios | Job diario | 60/30/7 días antes del vencimiento |
| Backups | Supabase Pro | **Prueba de restauración antes del piloto pagado** |

Entornos: `local` (Supabase CLI en Docker), `staging` (Supabase free + Railway; Google en modo demo) y `production`. Las migraciones son solo con Drizzle y se aplican en CI; nunca a mano en producción.

---

## 13. Pruebas

| Tipo | Alcance | Herramienta |
|---|---|---|
| Unitarias | `packages/core`: reglas, metas, arrastre, límites, expiración, anulaciones | Vitest (cobertura > 90 % en `core`) |
| Integración | API + Postgres real (transacciones, idempotencia, concurrencia con 20 `earn` simultáneos, RLS) | Vitest + Supabase local |
| Aislamiento tenant | Suite dedicada: cada endpoint probado con un token de la organización B contra datos de A | Vitest, obligatoria en CI |
| Wallet | Firma `.pkpass` válida (se abre en simulador y en un iPhone real); JWT Google válido; servicio web Apple contra su especificación | Vitest + manual |
| E2E | Registro → tarjeta → caja suma ×10 → premio → canje → anulación | Playwright |
| Dispositivos | iPhone (Safari), Android gama media y baja (Chrome), lectura NFC, cámara con poca luz | Checklist manual por release |

---

## 14. Pendientes que no bloquean el desarrollo

| Pendiente | Recomendación | Fecha límite |
|---|---|---|
| Dedicación de la ingeniera | Definir horas por semana; el backlog está en semanas de tiempo completo (40 h) | Antes de la semana 1 |
| Dominios | Comprar ambos en la semana 1 (el corto por varios años) | Semana 1 |
| Entidad legal para Apple | **Decidir antes de emitir pases reales**: un Pass Type ID **no se transfiere** entre cuentas, y los pases emitidos con una cuenta personal habría que reemitirlos al pasar a empresa. Mientras tanto, el piloto funciona con la tarjeta web y Google. | Semana 5 |
| Hosting Node | Opción A: Railway US East + Supabase `us-east-1` | Semana 1 |
| Nombres de planes | Sugerencia: **Start / Pro / Multi** (cortos, funcionan en español e inglés) | Antes del autoservicio |
| Retención | Valores de la sección 10, a validar con el abogado | Antes del piloto pagado |
