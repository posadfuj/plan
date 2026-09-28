# Aiment Wallet: backlog semanal del MVP

Referencia técnica: [`arquitectura-v1.0.md`](./arquitectura-v1.0.md) · Modelo de datos: [`esquema-v1.0.sql`](./esquema-v1.0.sql)

**Supuesto:** 1 ingeniera a tiempo completo (~40 h/semana). A medio tiempo (20 h), cada semana equivale a 2 semanas de calendario.
**Duración:** 8 semanas de construcción + 2 de piloto y buffer = **10 semanas**.

## Cambios frente al roadmap de la respuesta v1.0

| Cambio | Motivo |
|---|---|
| La **tarjeta web pasa a la semana 3** (antes estaba en la 5) | El registro termina en la tarjeta, y la caja (semana 4) necesita escanear el QR que muestra la tarjeta. Sin ella no se puede probar el flujo completo. |
| El **motor de premios pasa a la semana 2** (en `packages/core`, sin UI) | La caja de la semana 4 necesita canjear. Premios ganados y canjes son lógica del núcleo, no un agregado final. |
| **Google (semana 6) y Apple (semana 7) van en semanas separadas** | Juntos en una semana es el punto más probable de retraso. Apple sola (firma, servicio web, APNs e imágenes) ya ocupa una semana. |
| Si la **entidad legal para Apple** no está lista en la semana 7, se intercambia con la semana 8 | El piloto puede arrancar con la tarjeta web + Google. |

---

## Carril del fundador (en paralelo, sin código)

| Semana | Tarea | Por qué es urgente |
|---|---|---|
| 1 | Confirmar la dedicación de la ingeniera | Define el calendario real |
| 1 | Comprar el dominio principal y el **dominio corto (por 5–10 años)** | Sin dominio no hay URLs cortas, correo ni configuración de Wallet |
| 1 | Definir la entidad legal para Apple: RUC, empresa o persona. Si es empresa, pedir el **D-U-N-S** | Es el trámite más lento; el Pass Type ID no se transfiere después |
| 1 | Crear cuentas: Supabase, Railway, Cloudflare, Google Cloud, Sentry, Resend y GitHub (la organización) | Las necesita la semana 1 de desarrollo |
| 1 | Crear la cuenta Google Wallet Issuer (perfil de negocio de Aiment Wallet) | Queda en modo demo hasta la aprobación |
| 2 | **Probar Google Wallet en 3–4 Android reales en Perú**, incluido uno de gama baja (con un pase de demo que prepara la ingeniera) | Valida el supuesto más importante del canal |
| 2–3 | Asesoría legal: términos para comercios con encargo de tratamiento, privacidad y términos del cliente final, flujo transfronterizo y ARCO | Se necesitan los textos en `consent_versions` para la semana 3 |
| 3 | Elegir los 2–3 negocios piloto y conseguir su logo, colores, premio y reglas | Se usan como datos reales de prueba desde la semana 5 |
| 4 | Comprar el lote de prueba de NTAG213/215 (Aiment Card) y el material de mostrador | Pruebas de grabado y bloqueo en la semana 8 |
| 5 | **Solicitar acceso de publicación a Google Wallet** con un flujo demostrable | La aprobación puede tardar semanas |
| 5–6 | Inscripción en Apple Developer (organización) + Pass Type ID | Se necesita en la semana 7 |
| 8 | Preparar el kit presencial: guion de onboarding, manual de caja de 1 página y soporte | Semana 9 de piloto |

---

## Semana 1: Base técnica

**Objetivo:** que el repositorio, los entornos y la base estén listos, y que cualquier cambio llegue a staging con CI en verde.

- [ ] Monorepo pnpm + Turborepo con `apps/{web,api,worker,edge-redirect}` y `packages/{core,db,wallet,contracts,ui}`.
- [ ] TypeScript estricto, ESLint, Prettier y Vitest configurados en todos los paquetes.
- [ ] Supabase local (CLI) + esquema Drizzle a partir de `esquema-v1.0.sql`; migración inicial reproducible.
- [ ] Rol `app_api`, esquema `app` no expuesto en la Data API y RLS activo.
- [ ] API Hono mínima con `/health`, logger estructurado, manejo de errores y Sentry.
- [ ] Worker con pg-boss conectado y un job de ejemplo.
- [ ] PWA React + Vite + Tailwind + shadcn/ui con rutas vacías: `/r`, `/c`, `/caja`, `/panel`, `/admin`.
- [ ] CI en GitHub Actions: lint, typecheck, tests y migraciones sobre un Postgres efímero.
- [ ] Deploy de staging (Railway + Supabase staging) desde `main`.
- [ ] **Pase de demo de Google Wallet** (JWT manual) para la prueba en campo del fundador.

**Terminado cuando:** un PR se despliega solo en staging, `/health` responde y el pase de demo se guarda en un Android.

---

## Semana 2: Multi-tenant, roles y motor de fidelización

**Objetivo:** un negocio aislado con usuarios y un programa, y un motor que suma, convierte, canjea y anula con pruebas.

- [ ] Middleware `AuthContext` (JWT Supabase → `member`/`superadmin`) y matriz de permisos `can()`.
- [ ] Repositorios de `packages/db` con `orgId` obligatorio y `withTenantTx(orgId, fn)` que ejecuta `set_config`.
- [ ] Endpoints de superadmin: crear organización (+ sucursal principal + dueño por invitación) y suspender/reactivar.
- [ ] Endpoints del dueño: crear y editar el programa (stamps/points), crear una nueva **versión de regla** y gestionar premios.
- [ ] `packages/core`: `computeEarn`, `applyGoal` (con arrastre), `checkLimits`, `computeRedeem`, `computeVoid` y `computeExpiration`.
- [ ] Servicio `ledger.earn / redeem / void / adjust` con transacción, `FOR UPDATE`, idempotencia (devuelve el resultado original), `balance_after`, `earned_rewards` y `event_outbox`.
- [ ] Tests: unitarios de `core` (> 90 %), 20 `earn` concurrentes sin saldo inconsistente, reintento con la misma clave, doble canje bloqueado y doble anulación bloqueada.
- [ ] **Suite de aislamiento tenant** (se amplía cada semana).

**Terminado cuando:** por API (sin UI) se puede crear un negocio, un programa de 10 sellos y hacer 10 `earn`. Se genera 1 `earned_reward`, se canjea una vez y el segundo canje falla. Los tests de aislamiento pasan.

Criterios del Plan Maestro que se cubren: 1, 6, 8, 9 (lógica), 10, 11 y 12.

---

## Semana 3: Clientes, URLs cortas, registro y tarjeta web

**Objetivo:** que un cliente escanee un QR, se registre y vea su tarjeta web con su QR.

- [ ] `short_links` por sucursal + generación del slug.
- [ ] Worker Cloudflare `edge-redirect`: KV → `302` con `c` y `v`, registro de `channel_visits`, *fallback* a la API y sincronización de KV desde el outbox.
- [ ] Landing `/r/:slug`: marca del comercio, formulario (nombre + celular; correo y cumpleaños opcionales), consentimientos versionados, Turnstile, rate limit y validación E.164 de Perú.
- [ ] `POST /v1/public/register`: crea `customer`, `consents` y `membership` (con `member_token`, `card_token` y `short_code`). Si el celular ya existe, responde sin revelar datos.
- [ ] **Tarjeta web** `/c/:cardToken`: comercio, programa, saldo, progreso visual, premios, QR `/m/<member_token>`, `short_code`, historial (últimos 10) y "Powered by Aiment Wallet". Cabeceras `noindex` y `no-referrer`.
- [ ] Página `/m/:token` para cámaras ajenas ("Preséntalo en caja", sin datos personales).
- [ ] `localStorage` → "Abrir mi tarjeta" al volver a escanear el QR del local.
- [ ] Recuperación por correo (Resend): enlace de un solo uso de 30 minutos y respuesta siempre neutra.
- [ ] Panel del dueño (mínimo): descargar el QR de la sucursal (SVG/PNG) y copiar la URL NFC.

**Terminado cuando:** desde un iPhone y un Android reales, escanear el QR de staging lleva al registro y a la tarjeta con QR. Registrar el mismo celular dos veces no crea un duplicado ni filtra datos.

Criterios del Plan Maestro: 3 y 4 (sin Wallet todavía).

---

## Semana 4: Modo trabajador (caja)

**Objetivo:** un trabajador suma, canjea y anula desde el celular en pocos segundos.

- [ ] Autorizar un dispositivo desde el panel (QR de 10 minutos → `device_secret` en cookie) y revocarlo.
- [ ] Gestión de trabajadores (nombre + PIN) en el panel; login en caja eligiendo el nombre + PIN; bloqueo tras 5 intentos; sesión de 12 h y "Cerrar turno".
- [ ] Pantalla de caja: botón grande **ESCANEAR CLIENTE** (`BarcodeDetector` con respaldo `zxing-wasm`), buscar por celular o código, ficha del cliente (nombre, saldo, premios).
- [ ] Acciones: **Sumar** (en modo points pide el importe), **Canjear** (lista de premios disponibles con confirmación), **Anular último** (con motivo, 15 min).
- [ ] Mensajes de límite (cooldown, tope) + **override con PIN del dueño**, auditado.
- [ ] Idempotency key por intención; reintento automático ante error de red; bloqueo del botón mientras está en curso.
- [ ] **QR de recuperación** en caja (token de un solo uso de 10 minutos).
- [ ] Bono de bienvenida en la 1.ª visita validada.
- [ ] UX: botones de al menos 56 px, alto contraste, uso con una mano y respuestas en menos de 1 s en 4G.

**Terminado cuando:** en un celular Android de gama media, escanear la tarjeta y sumar un sello toma **menos de 5 segundos**. Doble toque o red cortada no duplica. El canje se hace una sola vez.

Criterios del Plan Maestro: 5, 6, 8, 9 y 11. Desde esta semana, **el flujo completo funciona sin Wallet.**

---

## Semana 5: Panel del dueño y superadmin

**Objetivo:** configurar un negocio real sin tocar código.

- [ ] Marca: logo (subida a R2 con recorte y validación), colores con **chequeo de contraste**, textos, condiciones y contacto.
- [ ] Programa: plantillas por rubro (barbería, cafetería, restaurante, salón, gimnasio, lavadero, veterinaria y genérica) como presets editables. Regla, meta, premios, bono de bienvenida, límites y expiración (desactivada por defecto).
- [ ] Vista previa de la tarjeta web y maqueta aproximada de los pases.
- [ ] Clientes: lista, búsqueda, ficha con historial, ajuste manual (motivo obligatorio), bloqueo de membresía, rotación de `card_token` y solicitud de baja (anonimización).
- [ ] Sucursal (1 en la UI) y trabajadores/dispositivos.
- [ ] Superadmin: lista de negocios con su estado (`draft → live → suspended`), uso básico (clientes, movimientos, pases) y auditoría.
- [ ] Cargar los datos reales de los negocios piloto en staging.

**Terminado cuando:** el fundador configura un negocio piloto completo desde el panel en **menos de 15 minutos**, sin ayuda técnica.

Criterios del Plan Maestro: 1, 2 y 12.

---

## Semana 6: Google Wallet

**Objetivo:** emitir y actualizar pases de Google desde la tarjeta web.

- [ ] `packages/wallet/google`: crear/actualizar `LoyaltyClass` por programa (con sincronización al publicar o cambiar la marca).
- [ ] Emisión: JWT "Save to Google Wallet" desde la tarjeta web y registro en `wallet_passes`.
- [ ] Generador de strip/hero de sellos con `sharp`, con caché en R2 por `(designHash, count, goal)`.
- [ ] Dispatcher outbox → cola `wallet.google.update` con `singletonKey` y *debounce*, más `PATCH` del objeto.
- [ ] `addMessage` con notificación solo en `goal_reached`.
- [ ] Reintentos, `last_error`, alertas y botón "Resincronizar" en el superadmin.
- [ ] Test: el proveedor caído no afecta a la caja.

**Terminado cuando:** en un Android real, el pase se guarda, la caja suma y **el pase refleja el saldo en menos de 1 minuto**. Con Google simulado caído, la caja sigue operando y el pase se pone al día al volver.

Criterio del Plan Maestro: 7 (Google).

---

## Semana 7: Apple Wallet

**Objetivo:** emitir y actualizar pases de Apple.

- [ ] `packages/wallet/apple`: generación de `.pkpass` (`passkit-generator`), Store Card con los campos de la arquitectura (7.2), `backFields` con "Powered by Aiment Wallet" y `locations`.
- [ ] Imágenes: icon, logo y strip @1x/@2x/@3x (reutilizando el generador de sellos).
- [ ] Servicio web de Apple: los 5 endpoints, `authenticationToken` y `passesUpdatedSince`.
- [ ] Cliente APNs HTTP/2 persistente con el certificado; manejo de `410` (baja del dispositivo).
- [ ] Cola `wallet.apple.update`: sube `pass_version` y hace push a todos los dispositivos registrados.
- [ ] Job diario de vencimiento del certificado (alertas a 60/30/7 días).
- [ ] Botón "Agregar a Apple Wallet" oficial en la tarjeta web (Safari iOS).

**Terminado cuando:** en un iPhone real, el pase se agrega, la caja suma y el pase se actualiza solo, con notificación al alcanzar el premio.

Criterio del Plan Maestro: 7 (Apple). *Si la cuenta de Apple no está lista, se intercambia con la semana 8.*

---

## Semana 8: Automatizaciones, reportes y hardening

**Objetivo:** dejar el producto listo para un negocio real.

- [ ] Automatizaciones `welcome`, `goal_reached` y `almost_there` con `automation_runs`, y activación/desactivación en el panel.
- [ ] Reportes del dueño: altas (por canal QR/NFC/directo), visitas, clientes con 2+ visitas, premios ganados/canjeados y **actividad por trabajador** (movimientos, anulaciones, overrides).
- [ ] Exportación CSV de clientes y movimientos (solo dueño/admin, auditada).
- [ ] PDF imprimible de mostrador (marca del comercio + QR + "Powered by Aiment Wallet").
- [ ] Hardening: CSP, HSTS, revisión de rate limits, `pnpm audit`, revisión de logs (sin tokens ni datos personales) y superadmin con TOTP.
- [ ] Observabilidad: uptime, métrica de lag del outbox, alertas de fallos de Wallet y de vencimiento de dominios.
- [ ] E2E Playwright del flujo crítico + checklist en dispositivos (iPhone, Android medio y bajo, NFC y poca luz).
- [ ] Grabar y **bloquear** NFC reales; registrar en `physical_tags`.
- [ ] **Probar la restauración de un backup** de Supabase en producción.
- [ ] Deploy de producción; migrar los negocios piloto; pasarlos a `live`.

**Terminado cuando:** los 12 criterios de aceptación del Plan Maestro se demuestran de punta a punta en producción.

---

## Semanas 9–10: Piloto y buffer

- [ ] Onboarding presencial de 1–2 negocios con el kit (QR + NFC + mostrador).
- [ ] Visita de observación en caja: tiempo por operación y errores de los trabajadores.
- [ ] Revisión diaria de Sentry, fallos de Wallet y reporte por trabajador.
- [ ] Corrección de fricciones (prioridad: caja > registro > panel).
- [ ] Documentación: runbook (renovar el certificado Apple, rotar secretos, restaurar un backup, suspender un negocio), variables de entorno y manual del dueño.
- [ ] Métricas del piloto (sección 17 del Plan Maestro) → decidir la fase 2.

**Norte:** si el comercio necesita soporte para acreditar una visita, el MVP no está listo.

---

## Fase 2 (orden sugerido, después del piloto)

1. Cumpleaños e inactividad (crons sobre el motor existente).
2. WhatsApp Cloud API (recuperación de tarjeta + campañas con consentimiento de marketing).
3. Autoservicio: registro, wizard (el mismo del panel), estado `pending_review` para Wallet, cobro recurrente (Mercado Pago/Culqi/Izipay), facturación SUNAT (PSE/OSE) y límites por plan (Start/Pro/Multi).
4. Múltiples sucursales con reportes consolidados y roles por sucursal.
5. Modo soporte con suplantación auditada.
6. Tags NFC dinámicos (NTAG 424 DNA) para visitas sin trabajador.
7. White-label premium y API pública.
