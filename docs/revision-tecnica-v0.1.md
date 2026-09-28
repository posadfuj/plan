# Revisión técnica del Plan Maestro v0.1: Fidelización digital + Wallet

Fecha: 28/09/2026 · Documento revisado: *Plan Maestro Fidelización Wallet v0.1* (27/09/2026)

> Los precios, límites y políticas de terceros (Apple, Google, Supabase, Cloudflare, Meta, pasarelas) cambian a menudo. Todo lo marcado con **[verificar]** hay que reconfirmarlo en la fuente oficial antes de contratar.

---

## 0. Veredicto corto

El plan está **bien pensado a nivel de producto y de principios**: ledger inmutable, saldo solo en servidor, QR que identifica sin guardar el saldo, URL corta desacoplada, multi-tenant en una sola base, sin POS y sin app nativa. En eso no cambiaría la dirección.

Lo que **sí cambiaría**:

1. **Dónde corre el backend.** Cloudflare Workers como API principal complica justo la parte más delicada, que es Apple Wallet: firma PKCS#7, push por APNs sobre HTTP/2 con certificado cliente, y generación de imágenes. Propongo **un backend Node.js (TypeScript)** en un contenedor gestionado y usar Cloudflare solo para lo que hace mejor: DNS, redirección de la URL corta, anti-bots y archivos.
2. **Una "tarjeta web" como canal base**, con Wallet como capa encima. En Perú la mayoría de los teléfonos son Android y muchos equipos de gama baja no tienen Google Wallet funcional. Sin un respaldo web, una parte de los clientes se queda sin tarjeta.
3. **Varios ajustes al modelo de datos** (sección 2) que faltan y que después cuestan caro: `organization_id` en todas las tablas, registros de dispositivos Apple, *outbox* de eventos, premios ganados como entidad propia, consentimientos versionados y clientes por negocio (no globales).
4. **Una escala realista.** 100 negocios no son un problema de base de datos: son unas decenas de miles de membresías y como mucho algunos millones de movimientos al año, algo que Postgres maneja sin esfuerzo. Lo difícil a esa escala es **la operación**: onboarding, soporte, certificados, aprobaciones de Wallet y fraude de empleados. La arquitectura debe optimizar para eso, no para tráfico.

---

## 1. ¿La arquitectura sirve para empezar y escalar a 100+ negocios?

**Sí en lo conceptual; con ajustes en lo concreto.**

| Punto del PDF | Evaluación | Comentario |
|---|---|---|
| Multi-tenant en una sola base y un solo proyecto | ✅ Correcto | No crear un proyecto por comercio. |
| Ledger append-only + saldo materializado | ✅ Correcto | Es la decisión más importante del documento. |
| API como único escritor de saldos | ✅ Correcto | Además hay que **cerrar el acceso directo** del frontend a la base (ver riesgos). |
| React/Vite para paneles | ✅ Correcto | Todo en PWA; sin app nativa. |
| Cloudflare Workers como API | ⚠️ Cambiar | Ver sección 7: límites de CPU, APNs HTTP/2 + mTLS, `sharp` y conexiones a Postgres. |
| Supabase gratis para el piloto | ⚠️ Solo para desarrollo | El plan gratis **pausa proyectos inactivos** y no incluye backups gestionados. Con negocios reales, Pro desde el día 1. |
| "Cron / Queue / scheduler" | ⚠️ Falta definir | Propongo una cola sobre el mismo Postgres (pg-boss o Graphile Worker) + patrón *outbox*. Sin infraestructura adicional. |
| Interfaces de proveedor Wallet | ✅ Correcto | Mantenerlas: `WalletProvider { issue, update, revoke }`. |
| Entornos dev/staging/prod | ✅ Correcto | Staging puede ir en plan gratis. |

**Números de referencia para 100 negocios:** ~500 clientes por negocio → ~50.000 membresías; ~20 movimientos diarios por negocio → ~730.000 filas de ledger al año. Es una carga pequeña para Postgres. Con 1.000 negocios sigue siendo manejable con índices correctos.

---

## 2. Cambios en la estructura técnica y la base de datos

### 2.1 Reglas generales

- **`organization_id` en todas las tablas de negocio**, también en `ledger_entries`, `redemptions`, `wallet_passes`, `memberships` y `automation_runs`, aunque se pueda deducir por joins. Así las políticas RLS e índices son simples y la consulta nunca "salta" de tenant.
- **IDs UUIDv7** (ordenables por tiempo), sin IDs secuenciales expuestos.
- **`timezone` y `currency` por organización.** Cumpleaños, inactividad y reportes diarios dependen de la zona horaria, y a futuro abre la venta fuera de Perú.
- **Soft delete / estados** en lugar de borrar (el PDF ya lo pide para suspender negocios).

### 2.2 Entidades que faltan o que cambiaría

| Entidad | Cambio | Por qué |
|---|---|---|
| `customers` | **Por organización** (`UNIQUE(organization_id, phone)`), no global | Según la Ley 29733, cada comercio es **titular** de su banco de datos y la plataforma es **encargada**. Un cliente global compartido entre negocios complica el consentimiento y la privacidad. Un perfil unificado entre negocios se puede agregar después. |
| `customer_consents` | **Nueva** | Guardar qué versión de términos/privacidad aceptó, cuándo, desde qué canal (QR/NFC/web) y qué finalidades (fidelización vs. marketing por separado). Es la evidencia legal del consentimiento. |
| `memberships` | Agregar `balance`, `lifetime_earned`, `version`, `short_code`, `member_token` (único) | Saldo materializado y actualizado **en la misma transacción** que el ledger. `short_code` (6–8 caracteres) permite escribirlo a mano si falla la cámara. |
| `ledger_entries` | Agregar `idempotency_key` (UNIQUE por org), `kind` (`earn`, `redeem`, `adjust`, `bonus`, `expire`, `reversal`), `amount_money` (monto de compra, separado de `delta`), `branch_id`, `actor_type` (staff/automation/system), `reverses_entry_id`, `program_version_id` | Idempotencia real, reversas sin editar, trazabilidad de qué regla se aplicó. |
| `program_versions` | **Nueva** | Si el dueño cambia "S/1 = 1 punto" a "S/2 = 1 punto", los movimientos históricos deben conservar la regla con la que se calcularon. |
| `reward_grants` (premios ganados) | **Nueva** | Separar "llegó a 10 sellos" de "canjeó". Al llegar a la meta se crea un *grant* disponible y se reinicia el contador. El canje consume ese grant. Permite acumular premios, que venzan y que se muestren en el pase. |
| `redemptions` | Referencia a `reward_grant_id` o a `reward_id` + ledger negativo | Canje en una sola transacción con bloqueo de fila. |
| `wallet_passes` | Agregar `serial_number`, `auth_token` (Apple), `google_object_id`, `pass_version`, `updated_at` | Apple lo exige para el servicio web de actualización. |
| `apple_device_registrations` | **Nueva** (`device_library_id`, `push_token`, `serial_number`) | **Falta en el PDF** y es obligatoria: sin esta tabla no hay actualización de pases Apple. |
| `wallet_classes` | **Nueva** (Google `LoyaltyClass` por programa) | Una clase por programa con la marca del negocio. |
| `domain_events` (*outbox*) | **Nueva** | Cada movimiento escribe un evento en la misma transacción. Un worker lo consume para sincronizar Wallet y disparar automatizaciones. Si Apple o Google fallan, se reintenta sin tocar el saldo. |
| `link_hits` | **Nueva** | Registrar escaneos de la URL corta (canal QR vs NFC, sucursal, conversión a registro). |
| `staff_devices` / PIN | **Nueva** | En caja, el celular suele ser compartido. Recomiendo "dispositivo autorizado + PIN personal de 4–6 dígitos" para que cada acción quede a nombre de quien la hizo sin obligar a iniciar sesión con correo. |
| `plans`, `plan_features`, `org_feature_overrides` | **Nueva** | *Feature flags* por plan, necesarias para el autoservicio. |
| `support_sessions` | **Nueva** (fase 2) | Modo soporte con trazabilidad. |

### 2.3 Simplificación: sellos = puntos

Técnicamente, **un sello es un punto con la regla "1 por visita"**. Un único motor de ledger con dos tipos de regla (`per_visit`, `per_amount`) evita duplicar lógica. La diferencia entre ambos es solo de presentación en el pase y en la pantalla del trabajador.

### 2.4 Expiración (decisión pendiente en el PDF)

Recomiendo **"los puntos vencen tras N meses sin actividad"** y no vencimiento por lote (FIFO). Es fácil de explicar al cliente, fácil de implementar (un job diario) y no obliga a rastrear lotes. Los `reward_grants` sí pueden tener fecha de vencimiento propia.

### 2.5 Esquema base propuesto (extracto)

```sql
-- Todas las tablas de negocio llevan organization_id + RLS
create table memberships (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  program_id uuid not null references loyalty_programs(id),
  customer_id uuid not null references customers(id),
  member_token text not null unique,          -- 128 bits aleatorios, va en el QR del pase
  short_code text not null,                   -- respaldo manual, único por organización
  balance integer not null default 0,         -- materializado, solo lo modifica la API
  lifetime_earned integer not null default 0,
  status text not null default 'active',
  version integer not null default 0,
  created_at timestamptz not null default now(),
  unique (program_id, customer_id),
  unique (organization_id, short_code)
);

create table ledger_entries (
  id uuid primary key,
  organization_id uuid not null,
  membership_id uuid not null references memberships(id),
  branch_id uuid,
  kind text not null check (kind in ('earn','bonus','redeem','adjust','expire','reversal','convert')),
  delta integer not null,
  amount_money numeric(12,2),                 -- monto de compra informado (si aplica)
  program_version_id uuid not null,
  actor_type text not null,                   -- staff | automation | system | superadmin
  actor_id uuid,
  reason text,                                -- obligatorio para 'adjust'
  reverses_entry_id uuid references ledger_entries(id),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (organization_id, idempotency_key)
);
create index on ledger_entries (organization_id, membership_id, created_at desc);

create table domain_events (                  -- outbox
  id bigserial primary key,
  organization_id uuid not null,
  type text not null,                         -- ledger.created, reward.granted, customer.registered...
  payload jsonb not null,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
```

Flujo de una suma de sello, **todo en una transacción**:
`SELECT ... FOR UPDATE` de la membresía → validar límites anti-fraude → `INSERT ledger` (con idempotency key) → `UPDATE memberships.balance` → si alcanza la meta, crear `reward_grant` + ledger `convert` → `INSERT domain_events` → `COMMIT`. La sincronización con Wallet ocurre **después y fuera** de la transacción.

---

## 3. Viabilidad de Apple Wallet y Google Wallet tal como se plantea

**Viable.** Es exactamente cómo operan las plataformas comerciales de fidelización con Wallet. Detalles que el PDF no cubre:

### Apple Wallet

- **Un solo Pass Type ID para toda la plataforma** alcanza. Cada pase puede llevar el logo, colores, textos y `organizationName` del comercio.
- **Inscribirse en Apple Developer como organización, no como persona.** Requiere RUC y **número D-U-N-S** (gratuito, pero puede tardar de días a semanas). Si te inscribes como persona, tu nombre personal aparece como vendedor. **Inicia este trámite ya**, porque es el camino crítico. **[verificar]**
- El servicio web de actualización tiene 5 endpoints obligatorios: registrar dispositivo, listar pases actualizados, entregar el pase más reciente, dar de baja y logs. Además requiere enviar un push por APNs con el certificado del Pass Type ID. APNs **solo acepta HTTP/2**, y esa es la razón técnica principal para usar Node.
- El **certificado vence cada año.** Si vence, no se pueden emitir ni actualizar pases. Hay que poner una alerta 60 días antes y documentar la renovación.
- **Sellos visuales:** para mostrar "7 de 10" como círculos llenos hay que **generar la imagen *strip*** por cada estado (0..N) y por programa, y guardarla en caché. Hace falta procesamiento de imágenes en servidor (`sharp`).
- El cliente solo ve una notificación en pantalla bloqueada si el campo modificado tiene `changeMessage`. Si no, el pase se actualiza en silencio.
- **Evitar NFC dentro del pase Apple**: requiere un certificado especial con aprobación de Apple. El PDF ya lo deja fuera, y está bien.
- Se pueden asignar **ubicaciones** al pase (las sucursales) para que aparezca como sugerencia cerca del local. Es un extra gratuito, sin garantía de que se muestre.

### Google Wallet

- **Una cuenta Issuer para la plataforma**, con una `LoyaltyClass` por programa y un `LoyaltyObject` por membresía.
- El botón "Guardar en Google Wallet" se implementa con un **JWT firmado** con la cuenta de servicio, sin necesidad de llamar a la API antes. Las actualizaciones se hacen con `PATCH` sobre el objeto.
- **Modo demo:** hasta que Google apruebe el acceso de publicación, solo usuarios de prueba pueden guardar pases. La revisión incluye el perfil del negocio y la marca. **Solicítalo en cuanto tengas un flujo demostrable** (semana 4–5).
- **Verifica en campo, en la semana 1**, que Google Wallet permite guardar pases en Perú con 3–4 teléfonos Android reales, incluido uno de gama baja. La disponibilidad de pagos y la de pases no siempre coinciden. **[verificar]**
- Las notificaciones push de Google tienen un límite diario por pase y no se garantiza su entrega. El PDF ya lo advierte, y está bien.

### Lo más importante: tarjeta web como respaldo

Por lo anterior, el cliente siempre debe tener **una tarjeta web** en `club.tudominio/c/{token}`, con su QR, saldo, premios y un botón "Agregar a Wallet". Esto:
- cubre a quien no tiene Wallet o no lo quiere usar,
- sirve para **recuperar la tarjeta** si cambió de teléfono,
- es el "portal del cliente" que el PDF deja para el futuro, casi sin costo adicional.

### Riesgo de branding multiempresa

Todos los negocios se emiten bajo **tus** cuentas de Apple y Google. Si un negocio de autoservicio sube la marca de un tercero (por ejemplo, alguien crea un "Club Starbucks" falso), el riesgo de suspensión es para **toda la plataforma**. En autoservicio, **la publicación en Wallet debe pasar por revisión** (manual al principio). La tarjeta web puede activarse de inmediato.

---

## 4. QR + NFC pasivo con la misma URL: ¿está bien diseñado?

**Sí, el diseño base es correcto.** La URL corta redirigible es lo que hace escalable al producto físico. Mejoras:

1. **Un dominio corto exclusivo para lo impreso**, distinto del dominio de la app, comprado por varios años y con renovación automática. Si ese dominio se cae o vence, **todos los kits físicos dejan de funcionar**.
2. **Redirector separado en el edge** (Cloudflare Worker + KV). Es de solo lectura y sigue funcionando aunque la app principal esté caída o en mantenimiento, porque solo resuelve `slug → destino`.
3. **Misma URL con marca de canal:** el NFC graba `…/X8P2K?c=n` y el QR `…/X8P2K?c=q`. El destino es el mismo y permite medir qué canal convierte (el PDF pide medir altas por local).
4. **Una URL por sucursal**, no solo por negocio.
5. **Bloquear el tag NFC después de grabarlo** (lock permanente o contraseña en NTAG213/215). Un sticker sin bloquear en un mostrador puede ser reescrito por cualquiera con una app gratuita. Como la URL es redirigible, bloquearla no quita flexibilidad. Esta es la ventaja práctica de la URL corta.
6. **Riesgo físico:** alguien puede pegar un QR falso encima del original. Conviene usar un material con marca visible y que la landing muestre claramente el logo del negocio.
7. **Expectativas realistas del NFC:** en iPhone (XS o posterior) se lee con la pantalla desbloqueada, sin app. En Android, **muchos usuarios tienen el NFC apagado**. El QR es el canal principal y el NFC es un extra de conveniencia y diferenciación comercial.
8. **Nunca usar el QR/NFC del mostrador para que el cliente sume sellos por su cuenta.** Una URL estática se puede fotografiar y compartir. Si más adelante quieres "acerca tu celular y suma tu visita" sin trabajador, eso requiere **tags dinámicos NTAG 424 DNA (SUN/SDM)**, que generan un código distinto en cada lectura. Es un gran producto de fase 2 para **Aiment Card**.
9. **Registro con abuso:** como la landing es pública, alguien puede registrar 50 cuentas falsas para cobrar el bono de bienvenida. Control: **el bono se acredita en la primera visita validada por un trabajador**, no al registrarse; además, Cloudflare Turnstile y un límite de registros por IP y dispositivo.
10. **Cliente que vuelve a escanear el QR de registro:** hay que detectarlo (cookie o teléfono) y ofrecer "ya tienes tarjeta, ábrela o reenvíala", en lugar de crear un duplicado.

---

## 5. Riesgos técnicos, de seguridad y de escalabilidad

| # | Riesgo | Severidad | Mitigación |
|---|---|---|---|
| 1 | **Retraso en trámites de Apple (D-U-N-S) y en la aprobación de Google** | Alta (calendario) | Iniciar la semana 0, en paralelo al desarrollo. |
| 2 | **Fuga del certificado Apple o de la clave de Google** | Alta | Solo en gestor de secretos, cifrados en reposo, sin logs; rotación documentada. Con esas claves se pueden firmar pases con tu marca. |
| 3 | **Vencimiento del certificado Apple** | Alta | Alerta a 60/30/7 días; procedimiento de renovación probado. |
| 4 | **Fuga entre tenants por mal uso de Supabase** (`anon key` + PostgREST exponiendo tablas, o *service role* que ignora RLS) | Alta | El frontend **no** accede a la base directamente; toda la escritura y lectura de negocio pasa por la API. Las tablas quedan en un esquema no expuesto. RLS como segunda capa usando `set_config('app.org_id')` por transacción. Tests automáticos de aislamiento en CI (criterio 10 del PDF). |
| 5 | **Doble canje o doble suma** (doble clic, reintento de red) | Media | Idempotency key generada en el cliente por operación + `UNIQUE` en base + `SELECT … FOR UPDATE`. |
| 6 | **Fraude de empleados** (sellos a amigos o a sí mismos) | Media-alta; es el fraude real más común | Límite por membresía (p. ej. 1 sello cada X horas, configurable), tope diario por trabajador, reporte "actividad por trabajador" para el dueño, alerta de anomalías, anulación solo dentro de N minutos y con motivo. |
| 7 | **Supabase gratis pausado o sin backups** | Alta en piloto | Pro desde el primer negocio real; probar una restauración antes de cobrar. |
| 8 | **Límites de CPU y protocolo en Workers** | Media | Backend en Node (sección 7). |
| 9 | **Agotamiento de conexiones a Postgres** | Baja con Node persistente | Usar el pooler de Supabase; Node mantiene un pool fijo. |
| 10 | **Mala conectividad en el local** | Media | Pantalla del trabajador liviana, reintentos seguros gracias a la idempotencia y mensajes claros. **No** hacer modo offline en el MVP. |
| 11 | **Atraso en la actualización de Wallet** | Baja | El trabajador ve la confirmación al instante (viene de la base); el pase se actualiza en segundos o minutos. Nunca depender del pase para validar. |
| 12 | **QR del pase compartido por captura** | Baja | El escaneo muestra el nombre del cliente al trabajador. El riesgo es aceptable. |
| 13 | **Dependencia de un solo issuer** (una suspensión afecta a todos) | Media | Revisar la marca en autoservicio, cumplir políticas y mantener la tarjeta web como plan B. |
| 14 | **Incentivar reseñas de Google** | Media (negocio) | Si se combina con las tarjetas de reseñas de Aiment Card: **no dar puntos a cambio de reseñas**, porque las políticas de Google lo prohíben y pueden eliminar las reseñas del negocio. Sí se puede *invitar* a reseñar sin incentivo. |
| 15 | **Cumplimiento de la Ley 29733** y su reglamento vigente | Media-alta | Contrato de encargo de tratamiento con cada negocio, política de privacidad, consentimiento separado para marketing, mecanismo de baja, inscripción del banco de datos ante la ANPD según corresponda. **Confirmar con un abogado.** |
| 16 | **Facturación electrónica SUNAT** de las suscripciones | Media (autoservicio) | Integrar un PSE/OSE (p. ej. Nubefact) cuando se cobre online. |

---

## 6. MVP: indispensable vs. segunda etapa

### Indispensable (para el piloto con 2–5 negocios)

1. Multi-tenant, autenticación y roles (superadmin, dueño, trabajador con PIN).
2. Organización + 1 sucursal (el modelo soporta varias; la interfaz es mínima).
3. **Un programa por negocio**: sellos o puntos, una regla activa y hasta 3 premios.
4. Landing de registro por QR/NFC con consentimiento versionado.
5. **Tarjeta web** + **Google Wallet** + **Apple Wallet**, con actualización.
6. **Pantalla de caja**: escanear, buscar por teléfono o código, sumar, canjear y **anular el último movimiento** (con motivo).
7. Ledger, idempotencia, límites anti-fraude básicos y auditoría.
8. URLs cortas, QR descargable (PNG/SVG + PDF imprimible) y URL para grabar el NFC.
9. Reportes básicos: altas, visitas, canjes, actividad por trabajador y exportación CSV.
10. Automatizaciones síncronas: **bienvenida** (acreditada en la 1.ª visita), **premio alcanzado** y **"te falta 1"** como mensaje en el pase.
11. Panel de superadmin sencillo: crear, suspender y ver uso.
12. Recuperar tarjeta ("reenviar mi tarjeta" por teléfono y correo).

### Segunda etapa (después del piloto)

- Automatizaciones programadas: cumpleaños e inactividad (el motor ya existe gracias al *outbox*; solo falta el scheduler y la UI).
- Editor de plantillas con vista previa en vivo. En el piloto, tú configuras la marca desde el panel de superadmin.
- **Autoservicio**: registro, wizard, cobro recurrente, facturación SUNAT, límites por plan, revisión de marca.
- Varias sucursales con reportes consolidados y roles por sucursal.
- Modo soporte con suplantación auditada.
- Campañas y segmentos.
- **WhatsApp** (Cloud API de Meta). Para reactivar clientes inactivos es mucho más efectivo que el push de Wallet, que es limitado. Es tu especialidad y justifica el plan Pro.
- Niveles, referidos y cupones.
- Tags NFC dinámicos (NTAG 424 DNA) para visitas sin trabajador.
- POS y API pública.

---

## 7. Stack recomendado y por qué

| Capa | Recomendación | Por qué |
|---|---|---|
| Lenguaje | **TypeScript en todo** (monorepo con pnpm + Turborepo) | Un solo lenguaje; tipos y validaciones (Zod) compartidos entre frontend y API. |
| Frontend | **React + Vite + TanStack Router/Query + Tailwind + shadcn/ui**, como PWA | Paneles, caja y landing en una sola base de código. La landing y la tarjeta web son rutas livianas con *code-splitting*. |
| Lector QR | `BarcodeDetector` nativo (Chrome Android) con respaldo `zxing-wasm` (iOS Safari) | Rápido y sin app. |
| API + workers | **Node.js 22 + Hono + Drizzle ORM**, en contenedor gestionado (**Railway**, Fly.io o Render) | Node tiene librerías maduras para `.pkpass` (`passkit-generator`), HTTP/2 nativo para APNs con certificado cliente, `sharp` para imágenes de sellos y un pool estable a Postgres. Hono también corre en Workers si algún día quieres mover partes al edge. |
| Cola y jobs | **pg-boss** (cola sobre el mismo Postgres) + *outbox* | Reintentos, idempotencia y cron sin Redis ni servicios adicionales. |
| Base de datos | **Supabase Postgres (Pro)** | Postgres gestionado, backups, pooler y CLI para migraciones locales. |
| Auth | **Supabase Auth** para dueños y admins; **PIN + dispositivo autorizado** (propio) para trabajadores | Evita construir auth desde cero y mantiene la caja sin fricción. |
| Archivos | **Cloudflare R2** con dominio público | Google Wallet exige imágenes en URLs públicas; R2 no cobra salida de datos. |
| Edge | **Cloudflare**: DNS, Worker redirector + KV para URLs cortas, Turnstile | Lo que Workers hace mejor, en el plan gratis. |
| Correo | **Resend** (o similar) | Envío de tarjetas, recuperación e invitaciones a trabajadores. |
| Observabilidad | **Sentry** (errores) + monitoreo uptime (Better Stack/UptimeRobot) + logs del proveedor | Obligatorio antes del primer negocio real. |
| CI/CD | GitHub Actions: lint, tipos, tests, test de aislamiento tenant y migraciones | Criterios 10 y 11 del PDF automatizados. |

**¿Por qué no el stack exacto del PDF (Workers como API)?** El plan gratis de Workers tiene un límite de CPU muy bajo por solicitud, que una firma RSA de `.pkpass` puede superar. APNs exige HTTP/2 con certificado cliente, algo que no está resuelto de forma natural en Workers. `sharp` no corre en Workers. Y la conexión a Postgres requiere Hyperdrive o pooler. Todo tiene solución, pero cada una agrega complejidad para ahorrar unos US$5–10 al mes. No compensa.

**Alternativa válida:** Next.js en Vercel. Es productiva, pero el plan Hobby de Vercel no permite uso comercial (Pro cuesta ~US$20/mes por usuario **[verificar]**), y las funciones serverless no sirven para workers persistentes. Prefiero un contenedor Node con API + worker en el mismo servicio.

### Diagrama

```
                      ┌────────────── Cloudflare ─────────────────┐
QR / NFC ──► go.dom/X8P2K ──► Worker redirector (KV) ──┐  Turnstile │
                      └──────────────────────────────────┼──────────┘
                                                         ▼
Cliente ──► Landing / Tarjeta web (React PWA) ──► API Node (Hono) ──► Supabase Postgres
Trabajador ─► Caja PWA (escáner) ─────────────────┘     │  ▲            (RLS + ledger + outbox)
Dueño / Admin ─► Paneles (React) ─────────────────┘     │  │
                                                        ▼  │
                                          Worker pg-boss (mismo servicio)
                                           │          │           │
                                   Apple APNs +   Google Wallet   Resend / (fase 2) WhatsApp
                                   .pkpass         REST API
                                           ▼
                                   R2 (logos, strips de sellos)
```

---

## 8. Tiempo estimado del MVP

Supuesto: **1 desarrollador full-stack senior a tiempo completo**, apoyado con IA, y tú como product owner disponible para decidir rápido.

| Semana | Entregable |
|---|---|
| 0 (paralelo) | Trámites: D-U-N-S y Apple Developer (organización), Google Wallet Issuer, dominios, cuentas. Prueba de Google Wallet en Android reales. |
| 1–2 | Monorepo, CI, esquema, RLS, migraciones, auth y roles, organizaciones, sucursales, programas y ledger con tests. |
| 3 | URLs cortas + redirector, QR imprimible, landing de registro, consentimiento, tarjeta web. |
| 4 | Pantalla de caja: escaneo, búsqueda, suma, canje, anulación, idempotencia, límites. **Solicitar publicación a Google.** |
| 5 | Google Wallet: clase, objeto, botón de guardado y actualización vía outbox. |
| 6 | Apple Wallet: `.pkpass`, imágenes de sellos, servicio web y APNs. |
| 7 | Panel del dueño (marca, programa, clientes, reportes, CSV) y superadmin. |
| 8 | Automatizaciones básicas, auditoría, pruebas E2E y en dispositivos, hardening, manual de piloto y kit físico. |

- **Piloto listo: ~8 semanas** (≈ 320–400 h) con un senior. Con un perfil semi-senior o a medio tiempo, **12–16 semanas**.
- **Autoservicio + cobros + SUNAT:** +4–6 semanas.
- El riesgo de calendario **no es el código, son las aprobaciones de Apple y Google**. Por eso van en la semana 0.

---

## 9. Servicios, cuentas, APIs y certificados

**Obligatorios para el MVP**

| Servicio | Para qué | Costo aprox. **[verificar]** |
|---|---|---|
| Apple Developer Program (**organización**) + D-U-N-S | Pass Type ID, certificado de firma y APNs | US$99/año; D-U-N-S gratuito |
| Certificado Pass Type ID + certificado WWDR de Apple | Firmar pases | Incluido |
| Google Cloud project + cuenta de servicio | Firmar JWT y llamar a la Wallet API | Gratis |
| Google Wallet Issuer account + acceso de publicación | Emitir Loyalty passes | Gratis (requiere revisión) |
| Dominio de app + **dominio corto** para lo impreso | Landing, paneles y URLs de kits | ~US$10–50/año cada uno según TLD (.pe suele costar más) |
| Cloudflare (DNS, Workers, KV, R2, Turnstile) | Edge, redirector y archivos | Gratis al inicio; US$5/mes con el plan pago |
| Supabase Pro | Base de datos, auth y backups | US$25/mes |
| Hosting Node (Railway / Fly / Render) | API + worker | US$5–20/mes |
| Resend (u otro SMTP) | Correos transaccionales | Gratis hasta cierto volumen |
| Sentry + monitoreo uptime | Errores y disponibilidad | Gratis al inicio |
| GitHub | Código y CI | Gratis / US$4 por usuario |

**Para autoservicio (fase 2)**

- Pasarela con **cobro recurrente** que opere en Perú: Mercado Pago (suscripciones), Culqi, Izipay o Niubiz. Stripe no acepta comercios peruanos directamente.
- **Facturación electrónica SUNAT** vía PSE/OSE (p. ej. Nubefact).
- WhatsApp Business Platform (Cloud API de Meta), con cobro por mensaje de plantilla según país y categoría.
- Asesoría legal: términos, privacidad, contrato de encargo de datos y revisión de la Ley 29733.

---

## 10. Costos estimados

### Desarrollo (MVP piloto, ~320–400 h)

| Modalidad | Rango aproximado |
|---|---|
| Tú / Aiment Agency con 1 dev senior freelance en Perú (US$15–30/h) | **US$5.000–12.000** |
| Agencia o software factory LatAm | US$15.000–35.000 |
| Equipo en EE.UU./Europa | US$40.000–80.000+ |
| Fase 2 (autoservicio + cobros + SUNAT + automatizaciones programadas) | +40–60 % sobre el MVP |

### Infraestructura mensual

| Concepto | Piloto (2–5 negocios) | 100 negocios |
|---|---|---|
| Supabase | US$25 (Pro) | US$25–60 (Pro + compute mayor) |
| API + worker Node | US$5–10 | US$20–50 (2 instancias) |
| Cloudflare | US$0 | US$5–10 |
| Apple (US$99/año prorrateado) | ~US$8 | ~US$8 |
| Dominios (prorrateado) | ~US$3–8 | ~US$3–8 |
| Correo, Sentry, uptime | US$0 | US$20–60 |
| Google Wallet API | US$0 | US$0 |
| **Total aproximado** | **~US$40–55/mes** | **~US$80–200/mes** |

Con 100 negocios a S/49 (≈ US$1.300 de MRR), la infraestructura queda **por debajo del 10–15 % del ingreso**. Los mensajes de WhatsApp conviene trasladarlos al cliente como paquete o incluirlos solo en el plan Pro con tope.

Existe un camino "casi gratis" (Supabase y Railway gratuitos, ~US$10/mes), pero **no lo recomiendo con negocios reales**: pausas, sin backups y sin soporte.

---

## 11. Venta presencial + autoservicio: qué preparar desde ya

Aunque el autoservicio es fase 2, estas decisiones deben tomarse **desde el MVP** para no rehacer nada:

- **Todo configurable desde el panel, nada por código**: el onboarding presencial que haces tú debería usar el mismo wizard que usará el autoservicio. Así lo pruebas en cada visita.
- **Estado de publicación por organización**: `draft → pending_review → live → suspended`. En presencial lo apruebas tú al instante; en autoservicio queda en revisión para Wallet.
- **Plan y *feature flags* en la base desde el día 1**, aunque en el piloto todos estén en "Pro".
- **Kit físico dual**: en autoservicio el negocio descarga un PDF imprimible con su QR al instante y, opcionalmente, **pide el kit NFC de Aiment Card** con envío. Es un ingreso extra y un diferenciador frente a la competencia.
- **Zona horaria, moneda e idioma por organización**, para vender fuera de Perú sin reescribir.

### ¿Construir o revender?

Existen plataformas de fidelización con Wallet que ofrecen marca blanca para revendedores. Sirven para **validar en semanas** sin programar, pero su costo por negocio suele dejar poco margen con un precio de S/49 y no te dan control sobre los datos ni la diferenciación con NFC y automatizaciones. Con tu precio objetivo y tu perfil, **construir tiene sentido económico**. Una opción intermedia es hacer 1–2 pilotos con una plataforma existente mientras desarrollas, solo para validar la disposición a pagar y el flujo en caja.

---

## 12. Decisiones que necesito para cerrar la arquitectura definitiva

1. ¿Quién desarrolla (tú, alguien de tu equipo, un freelance) y a qué dedicación?
2. Datos obligatorios del cliente: ¿solo nombre + celular? ¿Correo opcional? ¿Fecha de nacimiento opcional?
3. ¿Validamos el celular con código (OTP por SMS o WhatsApp) o lo dejamos sin validar en el MVP? Recomiendo sin OTP y bono en la primera visita.
4. ¿Aceptas el cambio a backend Node en lugar de Cloudflare Workers como API?
5. ¿Nombre comercial y dominios? Son necesarios para Apple, Google y los kits impresos.
6. ¿Tienes RUC/empresa para inscribir Apple como organización?
7. Política de expiración: ¿"vence tras N meses sin actividad"?
