# Aiment Wallet: backlog semanal del MVP (v1.1, local-first)

Referencia técnica: [`arquitectura-v1.1.md`](./arquitectura-v1.1.md) · Modelo de datos: [`esquema-v1.1.sql`](./esquema-v1.1.sql)

**Supuesto:** 1 ingeniera a tiempo completo (~40 h/semana). A medio tiempo, cada semana equivale a 2 de calendario.
**Etapas:** semanas 1–6 local · semanas 7–8 Wallet vía túnel · semana 9 staging · semana 10 piloto.

## Ajustes sobre el roadmap del documento v1.1

| Ajuste | Motivo |
|---|---|
| **Panel del dueño (marca, programa, plantillas, clientes) en la semana 5** | El roadmap v1.1 no tenía una semana para configurar el negocio desde la interfaz. Sin eso no se cumple la definición de éxito: "operarlo de principio a fin sin tocar código". |
| Reportes, CSV y automatizaciones pasan a la **semana 6**, junto con el hardening | Hacen lugar al panel. Las automatizaciones del MVP son pequeñas (3 reglas síncronas o basadas en el outbox). |
| **Recuperación de tarjeta en las semanas 3–4** (antes en la 6) | Nace junto con la tarjeta web y la caja: el QR de recuperación lo muestra la caja. |
| **Túnel HTTPS desde la semana 3** | La cámara del navegador y las pruebas con NFC en celulares reales exigen HTTPS. |
| **Prueba rápida de Google Wallet en la semana 1** (≈ 2 h, US$0) | Valida pronto que los Android de Perú guardan pases, sin esperar a la semana 7. |
| **Proveedor Wallet simulado** desde la semana 2 | Outbox, colas y reintentos quedan probados antes de conectar Apple y Google. |

---

## Carril del fundador (en paralelo)

| Semana | Tarea | Costo |
|---|---|---|
| 1 | Confirmar la dedicación de la ingeniera | — |
| 1 | Crear una cuenta de Google Cloud y una **Google Wallet Issuer en modo demo** (para la prueba rápida) | US$0 |
| 1 | Crear la organización de GitHub | US$0 |
| 2 | Probar en 3–4 Android reales (incluido uno de gama baja) el pase de demo que prepara la ingeniera | — |
| 3 | Elegir 2–3 negocios piloto candidatos y conseguir sus datos de marca (se cargan como semilla "realista", sin clientes reales) | — |
| 4 | Comprar un lote de prueba de NTAG213/215 (Aiment Card) | Bajo |
| **≤ 6** | **Elegir y comprar el dominio único** (5–10 años, renovación automática, bloqueo) y moverlo a Cloudflare | ~US$10–15/año |
| 6–7 | Inscribirse en **Apple Developer (individual)** | US$99/año |
| 8 | Abogado: privacidad, términos, contrato de encargo con comercios y flujo transfronterizo | Según honorarios |
| 8 | Solicitar **acceso de publicación a Google Wallet** | US$0 |
| 9 | Contratar hosting de staging y producción (opción A) | ~US$40–55/mes |
| 9 | Preparar el kit presencial: guion, manual de caja de 1 página y NFC grabados con el dominio definitivo | — |

---

## Semana 1: Entorno local reproducible + multi-tenant base

- [ ] Monorepo pnpm + Turborepo, TypeScript estricto, ESLint, Prettier y Vitest.
- [ ] `docker-compose.yml` (postgres:16, mailpit, minio), `.env.example` y `README.md` de instalación desde cero.
- [ ] Drizzle con el esquema de `esquema-v1.1.sql`; `pnpm db:migrate`, `db:seed` y `db:reset`.
- [ ] Rol `app_api`, RLS y `withTenantTx(orgId)`.
- [ ] Better Auth en la API (correo + contraseña, magic link con Mailpit, TOTP para superadmin) y `AuthContext` + `can()`.
- [ ] Semillas: negocios A (barbería), B (cafetería) y C (veterinaria), más el superadmin.
- [ ] **Primera versión de la suite de aislamiento** (B no ve A) en CI (GitHub Actions con Postgres de servicio).
- [ ] Escaneo de secretos en CI.
- [ ] **Prueba rápida:** un script que firma un JWT de Google Wallet (modo demo) → enlace "Guardar" para la prueba en campo del fundador.

**Demostrable:** `docker compose up` + 3 comandos levantan todo. Un test prueba que el negocio B no ve al A.

## Semana 2: Motor de fidelización

- [ ] `packages/core`: `computeEarn`, `applyGoal` (con arrastre), `checkLimits`, `computeRedeem`, `computeVoid` y `computeExpiration`, con cobertura > 90 %.
- [ ] Servicio de ledger: `earn`, `redeem`, `void` y `adjust`. Transacción + `FOR UPDATE` + idempotencia (devuelve el resultado original) + `balance_after` + `earned_rewards` + `event_outbox` + auditoría.
- [ ] Versiones de regla (`program_rule_versions`) y premios.
- [ ] Dispatcher del outbox → pg-boss → **`FakeWalletProvider`**, con reintentos probados.
- [ ] Tests de integración: 20 `earn` concurrentes, reintento con la misma clave, doble canje, doble anulación y rechazo de `UPDATE`/`DELETE` en el ledger.

**Demostrable:** por API se suma 10 veces → premio ganado → canje una sola vez → anulación, sin editar el historial.

## Semana 3: Registro, dos tokens, tarjeta web y QR/NFC

- [ ] `short_links` por sucursal y `GET /go/:token` en la API (en local reemplaza al Worker), con registro en `channel_visits` (`c=q|n`).
- [ ] `/join/{joinCode}`: marca, formulario (nombre + celular; correo y cumpleaños opcionales), consentimientos versionados y rate limit.
- [ ] `POST /v1/public/register`: genera `member_scan_token` + `web_card_token` + `short_code`. Si el celular ya existe, responde de forma neutra.
- [ ] **Tarjeta web** `/m/{web_card_token}`: saldo, progreso, premios, QR `/s/{member_scan_token}`, `short_code`, historial y "Powered by Aiment Wallet".
- [ ] `/s/{token}` para cámaras ajenas, sin datos personales.
- [ ] "Abrir mi tarjeta" con `localStorage` y recuperación por correo (Mailpit).
- [ ] Panel mínimo: descargar el QR de la sucursal y copiar la URL NFC.
- [ ] **Túnel rápido** para probar con celulares reales.

**Demostrable:** un celular real escanea el QR (vía túnel), se registra un cliente ficticio y recibe su tarjeta web.

## Semana 4: Modo trabajador

- [ ] Autorización de dispositivo (QR de 10 min → cookie) y revocación.
- [ ] Trabajadores con PIN; login en caja (nombre + PIN), bloqueo por intentos, sesión de 12 h y "Cerrar turno".
- [ ] Caja: **ESCANEAR CLIENTE** (`BarcodeDetector` con respaldo `zxing-wasm`), búsqueda por celular o código y ficha del cliente.
- [ ] Sumar (con importe en modo puntos), canjear, anular el último movimiento (15 min, con motivo) y override de límites con PIN del dueño.
- [ ] QR de recuperación en caja (un solo uso, 10 min).
- [ ] Bono de bienvenida en la 1.ª visita validada.
- [ ] UX: botones de al menos 56 px, uso con una mano y menos de 5 s por operación en un Android de gama media.

**Demostrable:** el flujo completo de caja funciona en local desde un celular real.

## Semana 5: Panel del dueño y superadmin

- [ ] Marca: logo (subida a MinIO), colores con chequeo de contraste, textos, condiciones y contacto.
- [ ] Programa: plantillas por rubro como presets editables; regla, meta, premios, bienvenida, límites y expiración (desactivada).
- [ ] Vista previa de la tarjeta web.
- [ ] Clientes: lista, búsqueda, ficha, ajuste con motivo, bloqueo, rotación del `web_card_token` y baja (anonimización).
- [ ] Trabajadores y dispositivos.
- [ ] Superadmin: crear negocio (+ sucursal + invitación al dueño), estados `draft → live → suspended`, uso y auditoría.

**Demostrable:** se configura un negocio ficticio nuevo, de cero a su primera tarjeta, **sin tocar código**, en menos de 15 minutos.

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
- [ ] Cola `wallet.google.update` con *debounce* y `PATCH`; `addMessage` en `goal_reached`.
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
