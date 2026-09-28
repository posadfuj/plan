# Aiment Wallet: backlog semanal del MVP (v1.1, local-first)

Referencia técnica: [`arquitectura-v1.1.md`](./arquitectura-v1.1.md) · Modelo de datos: [`esquema-v1.1.sql`](./esquema-v1.1.sql)

**Supuesto:** 1 ingeniera a tiempo completo (~40 h/semana). A medio tiempo, cada semana equivale a 2 de calendario.
**Etapas:** semanas 1–6 local · semanas 7–8 Wallet vía túnel · semana 9 staging · semana 10 piloto.

## Ajustes sobre el roadmap del documento v1.1

| Ajuste                                                                           | Motivo                                                                                                                                                                         |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Panel del dueño (marca, programa, plantillas, clientes) en la semana 5**       | El roadmap v1.1 no tenía una semana para configurar el negocio desde la interfaz. Sin eso no se cumple la definición de éxito: "operarlo de principio a fin sin tocar código". |
| Reportes, CSV y automatizaciones pasan a la **semana 6**, junto con el hardening | Hacen lugar al panel. Las automatizaciones del MVP son pequeñas (3 reglas síncronas o basadas en el outbox).                                                                   |
| **Recuperación de tarjeta en las semanas 3–4** (antes en la 6)                   | Nace junto con la tarjeta web y la caja: el QR de recuperación lo muestra la caja.                                                                                             |
| **Túnel HTTPS desde la semana 3**                                                | La cámara del navegador y las pruebas con NFC en celulares reales exigen HTTPS.                                                                                                |
| **Prueba rápida de Google Wallet en la semana 1** (≈ 2 h, US$0)                  | Valida pronto que los Android de Perú guardan pases, sin esperar a la semana 7.                                                                                                |
| **Proveedor Wallet simulado** desde la semana 2                                  | Outbox, colas y reintentos quedan probados antes de conectar Apple y Google.                                                                                                   |

---

## Carril del fundador (en paralelo)

| Semana  | Tarea                                                                                                                         | Costo            |
| ------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 1       | Confirmar la dedicación de la ingeniera                                                                                       | —                |
| 1       | Crear una cuenta de Google Cloud y una **Google Wallet Issuer en modo demo** (para la prueba rápida)                          | US$0             |
| 1       | Crear la organización de GitHub                                                                                               | US$0             |
| 2       | Probar en 3–4 Android reales (incluido uno de gama baja) el pase de demo que prepara la ingeniera                             | —                |
| 3       | Elegir 2–3 negocios piloto candidatos y conseguir sus datos de marca (se cargan como semilla "realista", sin clientes reales) | —                |
| 4       | Comprar un lote de prueba de NTAG213/215 (Aiment Card)                                                                        | Bajo             |
| **≤ 6** | **Elegir y comprar el dominio único** (5–10 años, renovación automática, bloqueo) y moverlo a Cloudflare                      | ~US$10–15/año    |
| 6–7     | Inscribirse en **Apple Developer (individual)**                                                                               | US$99/año        |
| 8       | Abogado: privacidad, términos, contrato de encargo con comercios y flujo transfronterizo                                      | Según honorarios |
| 8       | Solicitar **acceso de publicación a Google Wallet**                                                                           | US$0             |
| 9       | Contratar hosting de staging y producción (opción A)                                                                          | ~US$40–55/mes    |
| 9       | Preparar el kit presencial: guion, manual de caja de 1 página y NFC grabados con el dominio definitivo                        | —                |

---

## Semana 1: Entorno local reproducible + multi-tenant base ✔

Estado: **cerrada**. Detalle en [`semana-1-reporte.md`](./semana-1-reporte.md).

- [x] Monorepo pnpm + Turborepo, TypeScript estricto, ESLint, Prettier y Vitest.
- [x] Entorno local con **Supabase CLI** (Postgres 17 + Auth + Mailpit en Docker), `.env.example`, `pnpm local:env` y `README.md` de instalación desde cero. _(Reemplaza a docker-compose: ver ADR 0001.)_
- [x] Esquema Drizzle completo (30 tablas) + migración de seguridad; `pnpm db:migrate`, `db:seed`, `db:reset` y `db:check`.
- [x] Rol `app_api` sin `BYPASSRLS`, RLS forzado en todas las tablas de negocio, `withTenantTx(orgId)` y ledger/auditoría inmutables.
- [x] **Supabase Auth** en la API (JWKS/ES256, TOTP exigible para superadmin) + `AuthContext` + matriz de roles `can()`.
- [x] Semillas: barbería, cafetería y veterinaria con historial, premios, canjes y pases simulados, más el superadmin.
- [x] Suite de aislamiento (base + API) en CI con Postgres de servicio.
- [x] Escaneo de secretos (gitleaks) en CI.
- [x] Wallet simulado conectado al outbox y a pg-boss, con reintentos.
- [x] Generador del enlace de Google Wallet (modo demo) + guía. **Pendiente:** ejecutarlo con la cuenta emisora del fundador.

**Demostrable:** `pnpm local:setup` + `pnpm demo` → 19/19 verificaciones.

## Semana 2: Motor de fidelización ✔

Estado: **cerrada**. Detalle en [`semana-2-reporte.md`](./semana-2-reporte.md).

- [x] `packages/core`: reglas, `computeEarn`, `computeGoal` (con arrastre), `checkLimits`, `decideRedeem`, `decideVoid`, ajustes y expiración. Cobertura 99 % (CI exige 90 %).
- [x] Servicio `@aiment/ledger`: `earn`, `redeem`, `adjust`, `voidEntry` y `voidRedemption`. Transacción + bloqueo + idempotencia con respuesta original + `balance_after` + `earned_rewards` + outbox + auditoría.
- [x] Versiones de regla y premios (servicio + API).
- [x] Wallet simulado con **una cola por proveedor** (arrastrado de la semana 1).
- [x] Tests: 20 sumas concurrentes, reintento con la misma clave, doble canje, doble anulación, ledger inmutable.
- [ ] Prueba real de Google Wallet en Android: **pendiente de la cuenta emisora del fundador**.

**Demostrable:** `pnpm demo` → 23/23.

## Semana 3: Registro, dos tokens, tarjeta web y QR/NFC ✔

Estado: **cerrada** (salvo la prueba en celulares reales). Detalle en [`semana-3-reporte.md`](./semana-3-reporte.md).

- [x] `short_links` por sucursal y `GET /go/:slug` en la API, con registro en `channel_visits` (`c=q|n`, hash diario sin IP).
- [x] `/join/{código}`: marca, formulario (nombre + celular; correo y cumpleaños opcionales), consentimientos versionados y límite por IP.
- [x] `POST /v1/public/register`: `member_scan_token` + `web_card_token` + `short_code`; celular existente → sin duplicar y enlace al correo registrado.
- [x] **Tarjeta web** `/m/{web_card_token}` y página `/s/{member_scan_token}` sin datos personales.
- [x] "Abrir mi tarjeta" (`localStorage`) + **recuperación** por correo y en el local (un solo uso).
- [x] Panel mínimo: QR de la sucursal (PNG/SVG), URL para NFC y QR de recuperación.
- [x] E2E en Android e iPhone emulados + job de E2E en CI.
- [x] `pnpm local:tunnel` + checklist `prueba-celulares.md`.
- [ ] **Prueba en celulares reales:** pendiente del fundador (el entorno de la sesión bloquea el túnel).

**Demostrable:** `pnpm demo` → 8/8 en celulares emulados.

## Semana 4: Modo trabajador ✔

Estado: **aprobada** (salvo la prueba en celulares reales). Detalle en [`semana-4-reporte.md`](./semana-4-reporte.md).

- [x] Autorización de dispositivo (QR de 10 min → cookie) y revocación.
- [x] Trabajadores con PIN; login en caja (nombre + PIN), bloqueo por intentos, sesión de 12 h y "Cerrar turno".
- [x] Caja: **ESCANEAR CLIENTE** (`BarcodeDetector` con respaldo `zxing-wasm`), búsqueda por celular o código y ficha del cliente.
- [x] Sumar (con importe en modo puntos), canjear, anular el último movimiento (15 min, con motivo) y override de límites con PIN del dueño.
- [x] QR de recuperación en caja (un solo uso, 10 min).
- [x] Bono de bienvenida en la 1.ª visita validada.
- [x] UX: botones de al menos 56 px, uso con una mano y menos de 5 s por operación (medido con CPU 4× más lenta y red móvil).
- [x] Pedidos al aprobar la semana 3: cumpleaños dd/mm/aaaa, Wallet "Próximamente", URL de la tarjeta con hash y rotación ([ADR 0002](./decisiones/0002-token-de-tarjeta-con-hash.md)), límites con IP compartida ([ADR 0003](./decisiones/0003-limites-de-intentos.md)).
- [ ] **Flujo de caja desde un celular real:** pendiente del fundador (el entorno de la sesión bloquea el túnel).

**Demostrable:** `pnpm demo` → 14/14 en celulares emulados (caja con cámara simulada + flujo del cliente).

## Semana 5: Panel del dueño y superadmin ✔

Estado: **aprobada**. Agregado tras la aprobación: editar nombre y celular del cliente (#23). Invitar admins (#22) pasa a una fase posterior. Pendiente antes de la semana 6: prueba en celulares físicos. Detalle en [`semana-5-reporte.md`](./semana-5-reporte.md).

- [x] Marca: logo (almacenamiento local con interfaz S3; R2 en la semana 9), colores con chequeo de contraste, textos, condiciones y contacto.
- [x] Programa: plantillas por rubro como presets editables; regla, meta, premios, bienvenida, límites y expiración (desactivada).
- [x] Vista previa de la tarjeta web (el mismo componente que ve el cliente).
- [x] Clientes: lista, búsqueda, ficha, ajuste con motivo, anulación, bloqueo, invalidar la URL de la tarjeta, QR de recuperación y baja (anonimización).
- [x] Trabajadores y dispositivos (pantalla completa), **sucursal por trabajador con interfaz**, tope de trabajadores y de sucursales del plan.
- [x] Sucursales: alta, edición, QR/NFC propio, desactivación y reactivación.
- [x] Superadmin: crear negocio (+ sucursal + invitación al dueño), estados `draft → live → suspended`, plan, uso y auditoría.
- [x] Caja sin modo offline documentada ([ADR 0004](./decisiones/0004-caja-requiere-conexion.md)) y avisada en la interfaz.
- [ ] **Prueba en celulares reales** (cliente, caja y panel): pendiente del fundador (el entorno de la sesión bloquea el túnel).

**Demostrable:** `pnpm demo` → 20/20: un negocio ficticio nuevo, de cero a su primera tarjeta y su primera visita en caja, **sin tocar código** (13–15 s automatizado; falta medirlo con una persona).

## Semana 6: Reportes, automatizaciones y hardening

- [ ] Reportes: altas por canal (QR/NFC), visitas, clientes con 2+ visitas, premios ganados y canjeados, y **actividad por trabajador** (anulaciones, overrides).
- [ ] Exportación CSV (solo dueño/admin, auditada).
- [ ] Automatizaciones `welcome`, `goal_reached` y `almost_there` con `automation_runs`, activables o desactivables.
- [ ] PDF de mostrador (marca + QR + "Powered by Aiment Wallet").
- [ ] Hardening: CSP, revisión de rate limits, logs sin datos personales y `pnpm audit`.
- [ ] E2E con Playwright del flujo crítico, repetible con `db:reset`.
- [ ] `docs/runbook.md`: variables, migraciones y backup/restauración de Postgres (`pg_dump` probado).
- [ ] **Túnel con nombre** `dev.{dominio}` (si el dominio ya está comprado).

**Demostrable:** el MVP local es estable y se cumplen **todos** los criterios de la sección 14 de la arquitectura.

## Semana 7: Google Wallet (vía túnel)

- [ ] `GoogleWalletProvider`: clase por programa y objeto por membresía, con `issuer_ref`.
- [ ] Botón "Guardar en Google Wallet" en la tarjeta web.
- [ ] Generador de strip/hero de sellos (`sharp`), guardado en MinIO y servido públicamente vía túnel (o R2).
- [ ] Cola `wallet.google.update` con _debounce_ y `PATCH`; `addMessage` en `goal_reached`.
- [ ] Prueba de resiliencia: con Google caído, la caja sigue funcionando y el pase se pone al día al volver.

**Demostrable:** un pase de prueba se emite y se actualiza en un Android real tras sumar en caja.

## Semana 8: Apple Wallet (vía túnel)

- [ ] `AppleWalletProvider`: `.pkpass` (Store Card) con los campos de la sección 7.2, imágenes @1x/@2x/@3x e `issuer_ref`.
- [ ] Servicio web de Apple (5 endpoints) en `dev.{dominio}`.
- [ ] Cliente APNs HTTP/2 con el certificado; manejo de `410`.
- [ ] "Reemitir pase" desde la tarjeta web (prepara una futura migración de cuenta).
- [ ] Job de vencimiento del certificado.

**Demostrable:** un pase de prueba se agrega y se actualiza solo en un iPhone real.

## Semana 9: Staging online + QA real

- [ ] Hosting (opción A): API + worker + Postgres gestionado en la misma región; PWA y Worker de borde en Cloudflare.
- [ ] Migraciones desde CI, Sentry, uptime y alertas (lag del outbox, fallos de Wallet, vencimiento de dominio y certificado).
- [ ] QA en dispositivos: iPhone, Android de gama media y baja, NFC grabados con el dominio definitivo y poca luz.
- [ ] Prueba de **restauración de backup** en el Postgres gestionado.
- [ ] Textos legales cargados en `consent_versions`.

**Demostrable:** todo el flujo funciona desde celulares fuera de la red de la laptop.

## Semana 10: Piloto controlado (1–2 negocios)

- [ ] Producción y alta de los negocios piloto (`live`); kit QR + NFC instalado.
- [ ] Observación en caja: tiempo por operación y errores.
- [ ] Revisión diaria de Sentry, Wallet y actividad por trabajador.
- [ ] Corrección de fricciones (prioridad: caja > registro > panel).
- [ ] Métricas del piloto → decisión sobre la fase 2.

**Norte:** si el comercio necesita soporte para acreditar una visita, el MVP no está listo.

---

## Fase 2 (después del piloto)

1. Cumpleaños e inactividad.
2. WhatsApp Cloud API (recuperación de tarjeta y campañas con consentimiento).
3. Autoservicio: registro, wizard, `pending_review` para Wallet, cobro recurrente, comprobantes electrónicos y límites por plan (Start/Pro/Multi).
4. Multi-sucursal con reportes consolidados.
5. Modo soporte con suplantación auditada.
6. Revisión de la estructura legal y, si cambia la cuenta emisora, migración de pases vía `issuer_ref`.
7. NFC dinámico (NTAG 424 DNA), white-label y API pública.
