# Aiment Wallet: arquitectura v1.1 (local-first)

Estado: **vigente para el MVP**. Reemplaza a la v1.0 · Fecha: 28/09/2026
Base: _Plan Maestro v0.1_ → _Revisión técnica v0.1_ → _Respuesta v1.0_ → _Arquitectura corregida local v1.1_ (decisiones del fundador).
Complementos: [`esquema-v1.1.sql`](./esquema-v1.1.sql) (diseño de referencia; desde la semana 1 la fuente de verdad es `packages/db/src/schema.ts` + `packages/db/migrations`) y [`backlog-mvp.md`](./backlog-mvp.md).

> **Regla madre:** PostgreSQL + ledger son la fuente de verdad. La tarjeta web, Apple Wallet y Google Wallet son vistas sincronizadas del mismo estado. Wallet mejora el canal, pero el producto existe sin él.
>
> **Regla de etapa:** primero local → luego staging → recién después producción. No se paga infraestructura antes de necesitarla.

---

## 0. Qué cambió frente a la v1.0

| Tema            | v1.0                             | v1.1                                                                                                                  | Impacto técnico                                                                                    |
| --------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Entorno inicial | Staging online desde la semana 1 | **Local** con **Supabase CLI** (Docker: Postgres 17 + Auth + Mailpit) durante las semanas 1–8; staging en la semana 9 | Costo US$0 hasta la semana 7–8. Hace falta un túnel HTTPS para probar en celulares (sección 12.2). |
| Base de datos   | Supabase Pro                     | PostgreSQL de Supabase local; en producción, Supabase Pro                                                             | El esquema es Postgres estándar (no usa funciones propias de Supabase).                            |
| Auth            | Supabase Auth                    | **Supabase Auth** (decisión cerrada en la semana 1, ver [ADR 0001](./decisiones/0001-autenticacion.md))               | La API solo valida tokens (JWKS). Cambiar de proveedor afecta un único módulo.                     |
| Archivos        | R2                               | **Interfaz S3**: almacenamiento local → R2 en producción (semana 5)                                                   | Cambiar de proveedor es solo configuración.                                                        |
| Correo          | Resend                           | **Mailpit** (incluido en Supabase local) → proveedor transaccional al publicar                                        | —                                                                                                  |
| Dominios        | Dos (principal + corto)          | **Uno solo**, con subdominios y rutas                                                                                 | El único dominio pasa a ser infraestructura crítica (sección 2.2).                                 |
| Entidad         | Empresa para Apple               | **Persona individual** al inicio                                                                                      | Cuenta de Apple individual. Pass Type ID no transferible (sección 7.6).                            |
| Wallet          | Semanas 6–7                      | **Semanas 7–8**, después del núcleo local estable                                                                     | La tarjeta web es la referencia hasta entonces.                                                    |
| Tokens          | `member_token` / `card_token`    | **`member_scan_token`** / **`web_card_token`** (nombres del documento v1.1)                                           | Renombrados en el esquema.                                                                         |

---

## 1. Decisiones vigentes

| Tema                    | Decisión                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Marca                   | Aiment Wallet. Jerarquía: comercio → programa → "Powered by Aiment Wallet" (discreto y constante).                                         |
| Backend                 | Node.js 22 + TypeScript + Hono + Drizzle. API y worker en el mismo repositorio, como 2 procesos.                                           |
| Frontend                | React + Vite + TanStack Router/Query + Tailwind + shadcn/ui, como PWA.                                                                     |
| Base de datos           | PostgreSQL (Supabase), con esquema `app`, RLS y el rol `app_api` sin `BYPASSRLS`.                                                          |
| Auth                    | Supabase Auth (dueños, admins y superadmin con TOTP) + dispositivo autorizado y PIN (trabajadores, semana 4).                              |
| Jobs                    | `event_outbox` + dispatcher → pg-boss sobre el mismo Postgres.                                                                             |
| Archivos                | Interfaz S3 (almacenamiento local / R2 en producción).                                                                                     |
| Edge (al publicar)      | Cloudflare: DNS, router del dominio, redirector `/go/*`, Turnstile y hosting estático de la PWA.                                           |
| Wallet                  | Apple Store Card + Google Loyalty mediante una capa `WalletProvider`. Credenciales solo por configuración.                                 |
| Canal universal         | Tarjeta web.                                                                                                                               |
| Captación               | QR + NFC pasivo → misma URL `/go/{token}` por sucursal, con `?c=q` / `?c=n`. No acreditan puntos.                                          |
| Motor                   | Un solo ledger para sellos y puntos.                                                                                                       |
| Verificación de celular | No. El bono se acredita en la 1.ª visita validada.                                                                                         |
| Expiración              | Por inactividad, configurable (12 meses por defecto), desactivada en el piloto.                                                            |
| Fuera del MVP           | POS, app nativa, autoservicio con cobro, SUNAT, WhatsApp, editor avanzado, multi-sucursal con reglas distintas, NFC dinámico, white-label. |

---

## 2. Un solo dominio

### 2.1 Mapa de URLs

El dominio **no se escribe en el código**: sale de la configuración (`PUBLIC_BASE_URL`, `APP_BASE_URL`, `API_BASE_URL`). En local se usa `localhost` o la URL del túnel.

| Uso                                      | URL (ejemplo con `aimentwallet.com`)                 | Quién la sirve                                                               |
| ---------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| Sitio comercial                          | `aimentwallet.com/`                                  | Sitio estático (puede cambiar de proveedor sin romper nada)                  |
| **QR/NFC del local** (impreso)           | `aimentwallet.com/go/{branchToken}?c=q\|n`           | Worker redirector: registra la visita y responde `302`                       |
| Registro del negocio                     | `aimentwallet.com/join/{joinCode}`                   | PWA (rutas públicas)                                                         |
| **Tarjeta web**                          | `aimentwallet.com/m/{web_card_token}`                | PWA (rutas públicas)                                                         |
| QR de membresía (el que escanea la caja) | `aimentwallet.com/s/{member_scan_token}`             | PWA: si la abre alguien que no es la caja, solo muestra "Preséntalo en caja" |
| Panel, caja y superadmin                 | `app.aimentwallet.com` (`/panel`, `/caja`, `/admin`) | PWA                                                                          |
| API + servicio web de Apple              | `api.aimentwallet.com`                               | Node                                                                         |

**Cómo se enruta** (producción): Cloudflare está delante de todo el dominio. Un único Worker de borde atiende el apex:

- `/go/*` → redirector (KV `token → destino`, con _fallback_ a la API);
- `/join/*`, `/m/*` y `/s/*` → recursos estáticos de la PWA;
- el resto → sitio comercial.

Así los enlaces impresos **no dependen** de dónde esté alojado el sitio comercial. Hospedar la PWA en Cloudflare (static assets) cuesta US$0.

### 2.2 El único dominio es infraestructura crítica

Con un solo dominio, **todo** depende de él: los kits impresos, los tags NFC, la URL de cada tarjeta web y, sobre todo, cada pase de Apple y Google emitido. El `webServiceURL` y el QR quedan grabados dentro del pase, y cambiar de dominio rompe las actualizaciones de los pases existentes. Por eso:

- **Elegir el nombre definitivo antes de imprimir el primer kit real o emitir el primer pase real.** Para desarrollar local no hace falta.
- Comprarlo por **5–10 años**, con renovación automática, bloqueo de transferencia en el registrador, DNSSEC y alerta de vencimiento.
- Recomiendo comprarlo **a más tardar en la semana 6**: un túnel con nombre estable (`dev.aimentwallet.com`) exige tener el dominio en Cloudflare, y es lo que hace viables las pruebas de Wallet de las semanas 7–8 (sección 12.2).
- Un `.com` cuesta ~US$10–15 al año **[verificar]**.

---

## 3. Repositorio y entorno local

```
aiment-wallet/
├─ apps/
│  ├─ web/                 React PWA (join, tarjeta, caja, panel, admin)
│  ├─ api/                 Hono: rutas HTTP, validación de tokens de Supabase Auth, servicio web Apple
│  ├─ worker/              dispatcher del outbox + consumidores pg-boss + crons
│  └─ edge/                Cloudflare Worker (router del apex y /go/*), se usa al publicar
├─ packages/
│  ├─ core/                motor de fidelización PURO + tests
│  ├─ db/                  esquema Drizzle, migraciones, repositorios con tenant obligatorio, seeds
│  ├─ wallet/              WalletProvider + apple/ + google/ + fake/ (proveedor simulado para local)
│  ├─ storage/             interfaz S3 (local / R2) · semana 5
│  ├─ mail/                interfaz de correo (Mailpit / proveedor) · semana 3
│  ├─ contracts/           esquemas Zod compartidos
│  └─ ui/
├─ e2e/                    Playwright
├─ supabase/config.toml    stack local: Postgres 17 + Auth + Mailpit (Supabase CLI sobre Docker)
├─ .env.example            todas las variables, sin secretos reales
└─ README.md              instalación desde cero
```

**Levantar todo** (objetivo de la semana 1):

```bash
cp .env.example .env
pnpm local:setup              # Supabase local + .env + migraciones + datos de prueba
pnpm install
pnpm db:migrate && pnpm db:seed
pnpm dev                      # api + worker + web
```

**Datos semilla obligatorios** (`pnpm db:seed`):

| Negocio        | Programa                                     | Datos                                                                                                        |
| -------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| A: Barbería    | Sellos, 10 = corte gratis                    | 1 sucursal, dueño, 2 trabajadores, 30 clientes, movimientos, 3 premios ganados (1 canjeado)                  |
| B: Cafetería   | Puntos, S/1 = 1 punto; catálogo de 3 premios | 1 sucursal, dueño, 1 trabajador, 30 clientes, canjes                                                         |
| C: Veterinaria | Sellos, 6 = baño gratis                      | Incluye un cliente con el **mismo celular** que un cliente de A (prueba de que los clientes son por negocio) |
| Superadmin     | —                                            | 1 usuario con TOTP de prueba                                                                                 |

**Regla de dependencias:** `core` no importa `db`, `wallet` ni HTTP.
**Proveedor Wallet simulado (`fake`):** registra lo que "enviaría" a Apple/Google. Permite desarrollar y probar el outbox y los reintentos durante las semanas 1–6 sin cuentas externas.

---

## 4. Identidad, autenticación y autorización

### 4.1 Decisión: Supabase Auth

Cerrada en la semana 1. La comparación completa está en [ADR 0001](./decisiones/0001-autenticacion.md). En resumen: Supabase Auth corre en local con el mismo Supabase CLI (Docker), así que trabajar en local **no** obliga a cambiar de proveedor. Nos deja el cifrado de contraseñas, la recuperación, el TOTP y los límites de intentos a cargo de un servicio mantenido, y la API solo valida tokens con JWKS (ES256), igual en local que en producción.

### 4.2 Actores

| Actor               | Mecanismo                                                                                            | Sesión                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Superadmin          | Supabase Auth: correo + contraseña + **TOTP obligatorio** (`aal2`)                                   | Cookie de sesión `httpOnly` en `app.` (o _bearer_ en la API)        |
| Dueño / admin       | Supabase Auth: correo + contraseña o magic link (Mailpit en local)                                   | Ídem                                                                |
| Dispositivo de caja | El dueño lo autoriza desde el panel (QR de 10 min) → `device_secret`                                 | Cookie `httpOnly`, `Secure`, `SameSite=Strict`, 180 días, revocable |
| Trabajador          | En un dispositivo autorizado: nombre + PIN de 4–6 dígitos (argon2id, 5 intentos → bloqueo de 15 min) | `staff_session` de 12 h o hasta "Cerrar turno"                      |
| Cliente             | Sin cuenta. Tiene el `web_card_token`                                                                | —                                                                   |
| Apple Wallet        | `Authorization: ApplePass <token>`                                                                   | Por solicitud                                                       |

### 4.3 Autorización

- Middleware `AuthContext` (`superadmin | member | staff | card | system`) + matriz de permisos `can(ctx, acción)`.
- Los repositorios exigen `orgId`. `withTenantTx(orgId, fn)` abre la transacción con `set_config('app.org_id', …, true)`.
- **RLS** como segunda capa: la API se conecta como `app_api` (sin `BYPASSRLS`). `ledger_entries` y `audit_logs` no permiten `UPDATE`/`DELETE`, y un trigger bloquea cualquier edición del ledger. Esto está verificado en el esquema v1.1.
- La **suite de aislamiento** corre en CI desde la semana 1: con la sesión del negocio B, ningún endpoint lee ni escribe datos de A.

---

## 5. Motor de fidelización (sin cambios de fondo respecto a v1.0)

> **Implementado en la semana 2** (`packages/core/src/loyalty`, `packages/ledger`). Precisiones respecto a lo descrito abajo:
>
> - Rutas actuales (dueño/admin): `POST /v1/orgs/:orgId/memberships/:membershipId/{earn,redeem,adjust}`, `POST /v1/orgs/:orgId/ledger/:entryId/void` y `POST /v1/orgs/:orgId/redemptions/:redemptionId/void`. Las de caja (semana 4) usan el mismo servicio: `GET /v1/staff/scan/:scanToken` abre la ficha y las operaciones van por `membershipId` (`/v1/staff/memberships/:membershipId/{earn,redeem,recovery}`, `/v1/staff/ledger/:entryId/void`, `/v1/staff/redemptions/:redemptionId/void`); el negocio sale siempre del dispositivo.
> - El tope diario (`staff_daily_units`) aplica solo a trabajadores; el cooldown aplica a todos.
> - `caused_by_entry_id` vincula una suma con la conversión o el bono que generó; al anularla se revierten juntos.
> - Wallet: una cola por proveedor (`wallet.sync.google` / `wallet.sync.apple`).

| Concepto | Sellos                                                                  | Puntos                                            |
| -------- | ----------------------------------------------------------------------- | ------------------------------------------------- |
| Regla    | `per_visit` → +N                                                        | `per_amount` → `floor(importe / amount_per_unit)` |
| Meta     | `goal` → `earned_reward` + `convert` (−goal). El excedente se arrastra. | Catálogo de `rewards` con `cost`                  |
| Canje    | Consume un `earned_reward`                                              | `redeem` (−cost) + `redemption`                   |

**Operaciones de caja** (todas con `Idempotency-Key` por intención y en una sola transacción):

```
GET  /v1/staff/memberships/:scanToken
GET  /v1/staff/memberships?phone=…|code=…
POST /v1/staff/memberships/:scanToken/earn     { amount? }
POST /v1/staff/memberships/:scanToken/redeem   { earnedRewardId? | rewardId? }
POST /v1/staff/ledger/:entryId/void            { reason }
```

**Secuencia de `earn`:**

1. Si la clave de idempotencia ya existe, devolver el resultado original.
2. Bloquear la membresía con `FOR UPDATE`.
3. Calcular con `core`.
4. Validar límites; si se superan, devolver `409`, que admite override con el PIN del dueño.
5. Registrar el movimiento en el ledger.
6. Si es la 1.ª visita validada, aplicar el bono de bienvenida.
7. Si se alcanzó la meta, crear el premio ganado y el `convert`.
8. Actualizar el saldo materializado.
9. Escribir en `event_outbox`.
10. Registrar en auditoría si la acción es sensible.
11. `COMMIT` y responder con el estado leído de la base.

**Anulación:**

- El trabajador solo puede anular su último movimiento, dentro de 15 minutos y con motivo.
- El dueño puede anular cualquier movimiento, con motivo.
- Si el movimiento generó un premio que ya se canjeó, no se puede anular.
- Nunca se anula dos veces.

**Límites por defecto:** 1 sello cada 240 minutos por membresía, S/500 por transacción y 200 unidades por trabajador al día. El reporte "actividad por trabajador" permite detectar anomalías.

**Expiración:** job diario por zona horaria. Con `expiration_months = null` (piloto) no se ejecuta.

---

## 6. Flujo del cliente

1. `/go/{branchToken}?c=q` → el redirector registra la visita en `channel_visits` → `302 /join/{joinCode}?c=q&v={visitId}`.
   En local, el mismo endpoint lo sirve la API (`GET /go/:token`), así que el flujo se prueba sin Cloudflare.
2. Página `/join`:
   - marca del comercio;
   - nombre y celular (obligatorios);
   - correo y cumpleaños (opcionales, cada uno con su finalidad explicada);
   - términos + privacidad y un check **separado** de marketing;
   - Turnstile al publicar (en local no se usa).
3. `POST /v1/public/register`:
   - si el celular es nuevo, crea cliente + consentimientos + membresía (`member_scan_token`, `web_card_token`, `short_code`);
   - si ya existe en ese negocio, responde de forma neutra ("pídela en caja o por correo").
4. Redirige a `/m/{web_card_token}`, que se guarda en `localStorage` para ofrecer "Abrir mi tarjeta" al volver a escanear.
5. **La tarjeta web** muestra:
   - comercio, programa, saldo, progreso, premios y próximo premio;
   - el QR con `/s/{member_scan_token}` y el `short_code`;
   - el historial básico;
   - los botones de Wallet (cuando estén activos);
   - "Powered by Aiment Wallet".

   Lleva cabeceras `noindex` y `no-referrer`.

6. **Recuperación sin OTP:**
   - por correo: enlace de un solo uso de 30 minutos, con respuesta siempre neutra;
   - en caja: el trabajador busca por celular, verifica a la persona y muestra un QR de recuperación de un solo uso de 10 minutos;
   - el dueño puede **rotar** el `web_card_token`.

---

## 7. Wallet

### 7.1 Capa de proveedor

```ts
interface WalletProvider {
  readonly issuerRef: string; // cuenta emisora activa, desde configuración
  issue(m: MembershipView): Promise<IssueResult>;
  update(m: MembershipView, pass: WalletPassRef): Promise<void>;
  revoke(m: MembershipView, pass: WalletPassRef): Promise<void>;
}
// Implementaciones: FakeWalletProvider (local), GoogleWalletProvider, AppleWalletProvider
```

- **IDs separados:** los internos (UUID de Aiment Wallet) nunca se usan como credencial externa. `wallet_passes.external_id` guarda el serial/objectId, e `issuer_ref` guarda **con qué cuenta** se emitió cada pase.
- **Varias cuentas a la vez:** si mañana cambia la cuenta emisora (de persona a empresa), los pases viejos siguen actualizándose con la cuenta vieja mientras existan y los nuevos salen con la nueva. El motor no se toca: solo se agrega un `issuerRef` en la configuración.
- **Ningún dato personal del fundador** en claves, IDs, slugs ni textos del pase. `organizationName` y `logoText` son siempre el comercio, y la firma es "Powered by Aiment Wallet".

### 7.2 Apple (Store Card)

Sin cambios respecto a v1.0:

- `primaryFields` = saldo, `secondaryFields` = próximo premio, `auxiliaryFields` = "te falta 1" / premio disponible;
- `backFields` = condiciones, enlace a la tarjeta web y "Powered by Aiment Wallet";
- QR con `/s/{member_scan_token}` y `altText` con el `short_code`;
- `locations` = sucursales;
- strip de sellos generada con `sharp` y en caché por `(design, count, goal)`;
- servicio web con los 5 endpoints;
- push por APNs HTTP/2 con el certificado del Pass Type ID.

### 7.3 Google (Loyalty)

Sin cambios respecto a v1.0:

- `LoyaltyClass` por programa y `LoyaltyObject` por membresía;
- emisión con un JWT "Save to Google Wallet";
- actualización con `PATCH`;
- `addMessage` solo cuando se alcanza un premio;
- `linksModuleData` con "Powered by Aiment Wallet".

### 7.4 Sincronización

Outbox → pg-boss con `singletonKey = membershipId` y _debounce_ de ~3 s, reintentos con _backoff_ y `last_error` + alerta. Si el proveedor falla, la caja sigue funcionando.

### 7.5 Probar Wallet sin producción

| Necesidad                   | Apple                                                                                        | Google                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Endpoint HTTPS público      | Sí (`webServiceURL`)                                                                         | No para emitir; sí para que Google descargue las imágenes |
| URL estable                 | **Sí**: el `webServiceURL` queda grabado en el pase                                          | Las imágenes deben seguir accesibles                      |
| Solución en las semanas 7–8 | **Túnel Cloudflare con nombre** (`dev.aimentwallet.com`), gratis, con el dominio ya comprado | Ídem, o imágenes en R2 público (gratis)                   |

Con un túnel temporal cuya URL cambia en cada ejecución, los pases de prueba dejan de actualizarse cada vez que se reinicia. Sirve para una demo puntual, no para dos semanas de desarrollo.

### 7.6 Persona individual: qué implica

| Tema                                       | Implicancia                                                                                                                                                                                                                                                                                                 | Qué hacemos                                                                                                                                                                                       |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apple Developer individual                 | Se puede crear el Pass Type ID y firmar pases. La cuota es la misma (US$99 al año). La inscripción suele ser más rápida que la de organización.                                                                                                                                                             | Inscribirse en la semana 6–7, no antes.                                                                                                                                                           |
| **Pass Type ID no transferible**           | Si luego pasas a empresa con una cuenta Apple nueva, los pases emitidos con la cuenta individual **no se migran**. Siguen funcionando mientras esa cuenta y su certificado estén vigentes; para moverlos hay que **reemitirlos** (el cliente vuelve a tocar "Agregar a Apple Wallet" desde su tarjeta web). | `issuer_ref` por pase + función "reemitir pase" desde la tarjeta web. Con pocos pases en el piloto, el costo de migrar es bajo. Mantener activa la cuenta individual mientras queden pases vivos. |
| Google Wallet Issuer                       | La cuenta se crea con un perfil de negocio; el **acceso de publicación** implica una revisión de Google. **[verificar si aceptan persona natural o si piden más documentos]**                                                                                                                               | Crear la cuenta issuer en modo demo en la semana 1 (gratis) y pedir publicación en la semana 8. Si la revisión se demora, el piloto usa la tarjeta web + Apple.                                   |
| Cobros y comprobantes                      | Una persona natural con **RUC 10** puede emitir comprobantes electrónicos. No hace falta empresa para cobrar a los pilotos. **[confirmar con contador]**                                                                                                                                                    | Fuera del alcance técnico del MVP.                                                                                                                                                                |
| Contratos con comercios y datos personales | La plataforma es encargada del tratamiento. El contrato puede firmarse como persona natural.                                                                                                                                                                                                                | Revisar con abogado antes del piloto (semana 8).                                                                                                                                                  |

### 7.7 Secretos

- En local, todo va en `.env`, que nunca se sube: `.gitignore` + escaneo de secretos en CI.
- En producción, van en el gestor de secretos del hosting.
- Variables: `APPLE_PASS_TYPE_ID`, `APPLE_TEAM_ID`, `APPLE_PASS_CERT_P12_B64`, `APPLE_PASS_CERT_PASSWORD`, `GOOGLE_WALLET_ISSUER_ID`, `GOOGLE_WALLET_SA_JSON_B64`, `WALLET_ISSUER_REF_APPLE`, `WALLET_ISSUER_REF_GOOGLE`.
- Job diario de vencimiento del certificado de Apple, con alertas a 60/30/7 días.

---

## 8. QR/NFC y material físico

- `short_links.slug` = `branchToken` de 5–6 caracteres sin ambiguos, uno por sucursal. Destino editable sin reimprimir.
- **NFC:** NTAG213/215 con registro NDEF URI `https://{dominio}/go/{token}?c=n` → probar en iPhone y Android → **bloquear** → registrar en `physical_tags`.
- En local se pueden grabar tags apuntando a la URL del túnel **solo para pruebas**. Los tags del piloto se graban recién con el dominio definitivo.
- Panel: QR en SVG/PNG, PDF de mostrador y URL NFC por sucursal.

---

## 9. Automatizaciones del MVP

| Clave          | Disparo                           | Acción                                                                  |
| -------------- | --------------------------------- | ----------------------------------------------------------------------- |
| `welcome`      | 1.ª visita validada (síncrono)    | Bono o premio de regalo; mensaje en la tarjeta                          |
| `goal_reached` | `reward.earned`                   | Mensaje en la tarjeta; en el pase, con notificación (desde la semana 7) |
| `almost_there` | Falta 1 (o el umbral configurado) | Mensaje en la tarjeta y en el pase, sin push                            |

Cada ejecución queda en `automation_runs` con una clave de idempotencia. `birthday` e `inactivity` quedan para la fase 2 sobre el mismo motor.

---

## 10. Datos personales

- **Semanas 1–8:** solo datos **ficticios** (semillas). Nunca datos reales en laptops ni en backups locales.
- **Antes del piloto (semana 9–10):**
  - política de privacidad y términos versionados en `consent_versions`;
  - procedimiento de baja (anonimización);
  - contrato de encargo de tratamiento con cada comercio;
  - aviso de **flujo transfronterizo** si el hosting está fuera de Perú;
  - revisión legal de la Ley 29733.
- **Retención propuesta:** se mantiene la de v1.0. Anonimizar al cliente tras una baja o tras 24 meses sin actividad, 90 días de exportación al cancelar un negocio, 13 meses para `channel_visits` y 24 meses para `audit_logs`.

---

## 11. Seguridad transversal

HTTPS en todo lo publicado (HSTS), CORS restringido, CSP estricta y tokens de 128 bits en base62. Rate limits:

- registro: 30 por IP y 3 por celular y negocio cada 10 minutos (IP compartida / CGNAT: ver [ADR 0003](./decisiones/0003-limites-de-intentos.md));
- PIN: 5 intentos por persona (bloqueo de 15 min) y 20 por dispositivo cada 10 minutos;
- búsqueda: 30 por minuto y por dispositivo;
- recuperación: 20 por IP y 3 por contacto cada 10 minutos, y 3 correos por hora por cliente.

La URL de la tarjeta se guarda solo como hash y se rota al recuperar ([ADR 0002](./decisiones/0002-token-de-tarjeta-con-hash.md)).

La caja **necesita conexión a internet**: no hay modo sin conexión en el MVP, para evitar duplicados, fraude y canjes dobles ([ADR 0004](./decisiones/0004-caja-requiere-conexion.md)).

Archivos subidos (logo, semana 5): se validan por contenido (PNG, JPG o WebP; SVG rechazado), máximo 1 MB, clave aleatoria por subida y servidos con `nosniff` y CSP. En local se guardan en disco (`@aiment/storage`); en producción, R2 con la misma interfaz.

Logs sin tokens ni datos personales, `pnpm audit` y escaneo de secretos en CI.

---

## 12. Entornos

### 12.1 Etapas

| Etapa                | Semanas     | Qué corre                                                                              | Costo                                           |
| -------------------- | ----------- | -------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **Local**            | 1–8         | Supabase CLI (Postgres 17, Auth, Mailpit) + Node + Vite                                | US$0                                            |
| **Túnel de pruebas** | 3–8         | Cloudflare Tunnel hacia la laptop, para celulares reales (y Wallet en las semanas 7–8) | US$0 (requiere el dominio para una URL estable) |
| **Staging**          | 9           | Hosting Node + Postgres gestionado + Cloudflare (PWA y Worker de borde)                | ~US$5–25/mes                                    |
| **Producción**       | 10 (piloto) | Ídem, con backups verificados, monitoreo y alertas                                     | ~US$40–55/mes                                   |

### 12.2 Por qué hace falta un túnel desde la semana 3

- La **cámara del navegador** (escáner de la caja) solo funciona en `https://` o `localhost`. En un celular conectado por Wi-Fi a la IP de la laptop, **no abre**.
- Escanear un QR o tocar un NFC con un celular real necesita una URL alcanzable desde ese celular.
- Opciones:
  - **semanas 3–5:** un túnel rápido (`cloudflared tunnel --url`, gratis, URL temporal) o un certificado local con `mkcert`;
  - **desde la semana 6:** un túnel con nombre `dev.aimentwallet.com`, estable y gratis, que es la base de las pruebas de Wallet.

### 12.3 Producción (a decidir en la semana 9)

Regla: **la API y la base de datos en la misma región.**

| Opción          | Postgres                           | API + worker    |
| --------------- | ---------------------------------- | --------------- |
| A (recomendada) | Supabase Pro o Neon en `us-east-1` | Railway US East |
| B               | Supabase en `sa-east-1`            | Fly.io `gru`    |

Como el esquema es Postgres estándar y la auth vive en la API, cualquiera sirve.

---

## 13. Pruebas

| Tipo               | Alcance                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| Unitarias (`core`) | Reglas, metas, arrastre, límites, expiración y anulaciones. Cobertura > 90 %.                   |
| Integración        | API + Postgres de Docker: transacciones, 20 `earn` concurrentes, idempotencia y RLS             |
| **Aislamiento**    | Cada endpoint probado con la sesión de B contra datos de A (semillas A/B/C). Obligatoria en CI. |
| Ledger             | La base rechaza `UPDATE`/`DELETE` (ya verificado en el esquema)                                 |
| E2E (Playwright)   | Registro → tarjeta web → caja ×10 → premio → canje → anulación → recuperación                   |
| Wallet             | Proveedor simulado en CI; pruebas reales en dispositivo durante las semanas 7–8                 |
| Dispositivos       | iPhone (Safari), Android de gama media y baja, NFC y poca luz, vía túnel                        |

---

## 14. Criterios para salir de local (del documento v1.1, con la forma de verificarlos)

| Criterio                                      | Verificación                                                      |
| --------------------------------------------- | ----------------------------------------------------------------- |
| Instalación desde cero con el README          | Una persona distinta a la ingeniera la hace en una máquina limpia |
| Aislamiento con pruebas automáticas           | La suite de aislamiento pasa en verde en CI                       |
| La base rechaza edición y borrado del ledger  | Test de integración                                               |
| Idempotencia sin duplicados                   | Test de reintento + concurrencia                                  |
| Registro → tarjeta → caja → premio → canje    | E2E en verde 3 veces seguidas                                     |
| Backups, variables y migraciones documentados | `docs/runbook.md` + `.env.example` completo                       |
| Sin secretos en el repositorio                | Escaneo de secretos en CI                                         |
| E2E repetibles                                | Mismo resultado con `pnpm db:reset && pnpm e2e`                   |

---

## 15. Pendientes

| Pendiente                                                   | Recomendación                                                               | Cuándo                          |
| ----------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------- |
| Dedicación de la ingeniera                                  | Definir horas semanales. El backlog asume 40 h.                             | Antes de la semana 1            |
| Nombre del dominio                                          | Elegirlo y comprarlo (uno solo, por 5–10 años)                              | **A más tardar en la semana 6** |
| Cuenta Apple individual                                     | Inscribirse (US$99 al año)                                                  | Semana 6–7                      |
| Cuenta Google Issuer                                        | Crearla en modo demo                                                        | Semana 1 (gratis)               |
| Hosting de producción                                       | Opción A                                                                    | Semana 9                        |
| Legal (privacidad, contrato con comercios, transfronterizo) | Abogado                                                                     | Semana 8, antes de datos reales |
| Auth: Better Auth vs Supabase                               | **Cerrado: Supabase Auth** ([ADR 0001](./decisiones/0001-autenticacion.md)) | Semana 1 ✔                      |
