# Aiment Wallet: reporte de la semana 6

Fecha: 09/10/2026 · Alcance congelado: reportes, exportación CSV, automatizaciones, hardening y vencimientos programados, más lo que el backlog de esta semana ya incluía (PDF de mostrador, E2E del flujo crítico y runbook). No se agregaron funciones fuera del MVP.

## Resumen para decidir

| Pedido                                           | Estado                                                                                                                           |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Reportes                                         | **Hecho.** Panel → Reportes: altas por canal, visitas, clientes que volvieron, premios y actividad por persona (7, 30 o 90 días) |
| Exportación CSV                                  | **Hecho.** Clientes y movimientos; solo dueño o admin, auditada y protegida para Excel                                           |
| Automatizaciones                                 | **Hecho.** Bienvenida, premio ganado y "te falta poco" en la tarjeta; cada una se activa o apaga; sin duplicados                 |
| Hardening                                        | **Hecho.** Logs sin datos personales, CSP, PIN del dueño por negocio (deuda #16), límites revisados, `pnpm audit` en 0 y en CI   |
| Vencimientos programados                         | **Hecho** (deuda #3). Diario, a las 3:00 de cada negocio. La expiración de saldos sigue apagada en el piloto                     |
| PDF de mostrador, E2E del flujo crítico, runbook | **Hecho.** E2E en verde 3 veces seguidas tras `pnpm db:reset`; respaldo y restauración probados                                  |
| Túnel con nombre `dev.{dominio}`                 | **Bloqueado:** falta comprar el dominio (arquitectura §15: "a más tardar en la semana 6")                                        |
| Bugs de semanas anteriores                       | **3 encontrados y corregidos** (sección 5), uno con impacto legal: el panel decía que nadie aceptaba promociones                 |

## 1. Demo

```bash
pnpm local:setup     # si ya lo tenías: pnpm db:migrate (hay una migración nueva, la 0006)
pnpm demo            # semana 6: todas las suites E2E en Android e iPhone emulados (30/30)
```

Con `pnpm dev` corriendo (credenciales de prueba en `docs/prueba-celulares.md`):

1. **Reportes** (`/panel/reportes`): cifras grandes de clientes nuevos, que vinieron y que volvieron; altas por QR/NFC con sus escaneos; barras de visitas por día; premios ganados y canjeados; tabla de actividad por persona.
2. **Exportar**: "Clientes (con datos de contacto)" y "Movimientos de los últimos N días" descargan un CSV que Excel abre bien (tildes, ñ, celulares legibles).
3. **Mensajes automáticos** (`/panel/programa`, al final): tres mensajes con su interruptor, el umbral de "te falta poco" y cuántos salieron en 30 días. En la Veterinaria (plan Start) se ven, pero no se pueden activar.
4. **PDF de mostrador** (`/panel/sucursales`): "Descargar PDF de mostrador" genera un A5 con la marca, _"Junta 10 sellos y gana: Corte gratis"_, el QR y _"Powered by Aiment Wallet"_.
5. **Tarjeta del cliente**: tras la primera visita en caja aparece _"¡Gracias por tu primera visita!…"_. Con 9 de 10 sellos: _"¡Solo te falta 1 para Corte gratis!"_. Al completar: _"¡Completaste tu tarjeta! Ganaste: Corte gratis…"_. Cuando lo canjea, el mensaje desaparece.

Capturas: `e2e/artifacts/*-panel-11-reportes.png` y `*-panel-12-mensajes.png`.

## 2. Qué quedó terminado

### Reportes

Solo números agregados: el reporte **no trae datos personales** (lo comprueba un test). Los días se cuentan en la zona horaria del negocio.

| Bloque                | Qué muestra                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| Clientes              | Nuevos, que vinieron, que volvieron (2+ visitas), total y bloqueados                                         |
| Altas por canal       | QR, NFC y enlace directo, con los escaneos de cada QR/NFC                                                    |
| Visitas               | Total (las anuladas no cuentan) y barras por día                                                             |
| Premios               | Ganados (de la meta y de bienvenida) y canjeados                                                             |
| Actividad por persona | Visitas, anulaciones, excepciones pedidas y autorizadas, canjes y **PIN del dueño equivocados**, por persona |

### Exportación CSV

| Archivo     | Columnas                                                                                                                                    | Datos personales          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Clientes    | Nombre, celular, correo, cumpleaños, código, estado, saldo, visitas, premios por canjear y canjeados, **acepta promociones**, canal, fechas | Sí (es para el dueño)     |
| Movimientos | Fecha y hora, tipo, unidades, saldo, importe, **código de tarjeta**, sucursal, quién atendió, caja y motivo                                 | No: sin nombre ni celular |

- Solo dueño o admin; **cada descarga queda en la auditoría** (tipo, filas y período; nunca los datos).
- Límite de 20 descargas por persona por hora. Respeta la función `csv` del plan.
- **Inyección CSV:** un texto que empieza con `=`, `+`, `-` o `@` no se ejecuta como fórmula en Excel. UTF-8 con BOM. Los celulares de Perú salen como `987 654 321`.
- El panel recuerda que solo se puede escribir con fines comerciales a quien figura con "Acepta promociones: Sí" (Ley 29733).

### Automatizaciones (arquitectura §9)

| Mensaje       | Cuándo                                                                              |
| ------------- | ----------------------------------------------------------------------------------- |
| Bienvenida    | En la primera visita (menciona el bono si la regla lo da)                           |
| Premio ganado | Al completar la tarjeta (sellos) o cuando ya le alcanza para un premio (puntos)     |
| Te falta poco | Al **cruzar** el umbral (por defecto, falta 1 sello o el 10 % del premio en puntos) |

- Se evalúan **dentro de la misma operación de caja**, en un _savepoint_: si una automatización falla, la suma igual se registra.
- Cada ejecución queda en `automation_runs` con una clave única: **reintentar la suma no duplica el mensaje**. Si se anula la visita que lo disparó, el mensaje se retira.
- La tarjeta muestra solo el **último mensaje vigente** (14 días; un premio ya canjeado deja de anunciarse).
- Solo en planes con la función (Pro y Multi). El bono de bienvenida en sí se sigue configurando en la regla del programa.
- Cada ejecución emite `automation.ran`: en la semana 7 el pase de Wallet mostrará el mismo mensaje.

### Vencimientos programados (deuda #3)

Un trabajo de pg-boss corre cada hora; en cada negocio publicado actúa **a las 3:00 de su zona horaria**. Vence los premios con vigencia (hasta ahora nadie los vencía) y, **solo si el negocio lo configura**, los saldos inactivos: en el piloto la expiración de saldos sigue apagada. Es idempotente, y un negocio con error no frena a los demás. Los premios vencidos avisan a la tarjeta y al pase (`reward.expired`).

### PDF de mostrador

A5 vertical (también se imprime en A4), una página por sucursal: franja con el color y el logo, nombre del negocio, la promesa del programa, **QR vectorial** (no se pixela al imprimir), _"Escanea con la cámara de tu celular · Sin apps ni descargas"_, sucursal y _"Powered by Aiment Wallet"_. Las tildes y la ñ salen bien; un emoji en el nombre se reemplaza en lugar de romper el archivo.

### Hardening

| Tema                | Qué se hizo                                                                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Logs                | El log de errores escribía la ruta (con el token de la tarjeta o de la recuperación) y el error completo, que incluye los **parámetros SQL** (celulares, correos). Ahora: `:token` y error sin parámetros ni `detail` (API y worker) |
| CSP                 | Política estricta y cabeceras de seguridad en `vite preview` (las usa CI) y en `dist/_headers` para el despliegue. **Los E2E fallan si el navegador bloquea algo**                                                                   |
| PIN del dueño (#16) | Además del tope por caja, **tope por negocio** sumando todas sus cajas; cada intento fallido queda en la auditoría con quién y en qué caja, y aparece en Reportes                                                                    |
| Límites revisados   | Nuevo límite de exportaciones. El resto se mantiene según el ADR 0003                                                                                                                                                                |
| `pnpm audit`        | De **10 avisos (4 altos) a 0**: nodemailer 8 → 10 (envío probado con Mailpit) y versiones corregidas de dos dependencias de desarrollo. CI corre `pnpm audit`                                                                        |

### Runbook y criterios para salir de local (arquitectura §14)

[`docs/runbook.md`](./runbook.md): qué corre, variables, migraciones, trabajos programados, **respaldo y restauración probados**, logs e incidentes.

| Criterio                                   | Estado                                                                                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Instalación desde cero con el README       | ✅ En la Mac del fundador, una máquina distinta del entorno de desarrollo; los tropiezos (Node, Docker, `pnpm e2e`) quedaron en el README y el runbook |
| Aislamiento con pruebas automáticas        | ✅ **47 rutas** de negocio (+6) en la suite de aislamiento                                                                                             |
| La base rechaza editar o borrar el ledger  | ✅ Test de integración, y también en la base restaurada                                                                                                |
| Idempotencia sin duplicados                | ✅ Reintento y concurrencia; ahora también para los mensajes automáticos                                                                               |
| Registro → tarjeta → caja → premio → canje | ✅ **E2E en verde 3 veces seguidas** (30/30 cada vez)                                                                                                  |
| Respaldos, variables y migraciones         | ✅ Runbook + `.env.example`; restauración verificada                                                                                                   |
| Sin secretos en el repositorio             | ✅ gitleaks en CI                                                                                                                                      |
| E2E repetibles                             | ✅ `pnpm db:reset` y luego `pnpm demo` + `pnpm e2e` ×2: el mismo resultado                                                                             |

## 3. Resultados de pruebas

| Suite                                               | Tests   | Qué cubre (lo nuevo)                                                                                             |
| --------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| Unitarias                                           | 84      | + automatizaciones (15, 100 % de cobertura), CSV seguro y PDF (5), logs sin datos personales (3), hora local (2) |
| Integración: semana 6 por HTTP **(nueva)**          | 11      | Reporte medido antes y después de un recorrido real, CSV y su auditoría, límites, plan, PDF, mensajes            |
| Integración: automatizaciones **(nueva)**           | 10      | Bienvenida, meta, te falta poco, puntos, sin duplicados, anulación, plan, panel y falla aislada                  |
| Integración: API (aislamiento y roles)              | 22      | 47 rutas                                                                                                         |
| Integración: caja                                   | 30      | + PIN del dueño con tope por negocio                                                                             |
| Integración: base de datos (RLS)                    | 17      | + textos legales globales: se leen, no se modifican                                                              |
| Integración: worker                                 | 9       | + vencimientos por zona horaria, idempotentes y avisando a Wallet                                                |
| Integración: panel, público, ledger, editar cliente | 104     | Sin cambios de comportamiento                                                                                    |
| **Subtotal**                                        | **287** | Antes 236. Cobertura del motor: 99 % (CI exige 90 %)                                                             |
| **E2E en celulares emulados**                       | **30**  | Antes 22. + premio → canje en caja, reportes/CSV/PDF/mensajes, plan Start, búsqueda con respuesta lenta          |

**Tiempos de caja** medidos por el E2E (CPU 4× más lenta y red móvil simulada; meta < 5 s): escanear hasta la ficha 0,96 s · sumar 0,28–0,39 s · excepción con PIN 0,44 s · anular 0,17–0,25 s · buscar por código 0,32–0,39 s. Configuración de cero a la primera tarjeta: 11–14 s automatizado.

**CI:** verde en el [run #26](https://github.com/posadfuj/plan/actions/runs/38028366147) (lint, tipos, tests, E2E y escaneo de secretos). El run #25 había fallado en 6 E2E: la CSP bloqueaba el WebAssembly del lector de QR (iPhone/Safari y el Chromium de CI no traen `BarcodeDetector`). Se corrigió con `'wasm-unsafe-eval'` (solo habilita WebAssembly) y el proyecto E2E "iphone" ahora usa el lector zxing-wasm, así el error también aparece en la Mac.

## 4. Qué queda listo para Google Wallet y Apple Wallet (semanas 7–8)

| Pieza                                                                                                                  | Estado                                                         |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Interfaz `WalletProvider` y proveedor simulado; **una cola por proveedor** con reintentos                              | Listo desde la semana 1–2                                      |
| `wallet_passes` con `issuer_ref`, un pase activo por membresía y proveedor (permite reemitir)                          | Listo                                                          |
| Eventos que actualizan el pase: suma, premio ganado, canje, **premio vencido**, datos editados, **mensaje automático** | Listo (`reward.expired` y `automation.ran` son de esta semana) |
| Texto del mensaje (bienvenida, premio, te falta poco) para mostrarlo en el pase; `goal_reached` con notificación       | Texto listo; mostrarlo en el pase es trabajo de la semana 7    |
| Trabajos programados en el worker (pg-boss con horario)                                                                | Listo                                                          |
| Botones "Agregar a Wallet" en la tarjeta (deshabilitados, "Próximamente")                                              | Listo                                                          |
| `PUBLIC_BASE_URL` en enlaces, QR y PDF                                                                                 | Listo                                                          |
| **Dominio y túnel con nombre** (URL estable que Google y Apple puedan llamar)                                          | **Falta: comprar el dominio**                                  |
| Cuenta Google Issuer en modo demo (`docs/guia-google-wallet-demo.md`)                                                  | Pendiente del fundador                                         |
| Cuenta Apple Developer individual (US$99 al año)                                                                       | Pendiente del fundador                                         |
| Sincronizar cambios de regla y marca con los pases (`program.updated`, deuda #4)                                       | Semana 7                                                       |

## 5. Bugs encontrados y corregidos

| Bug                                                                                                                                                                                                  | Cómo se detectó                                       | Corrección                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **De la semana 5:** la ficha del cliente decía **"No acepta" promociones para todos**, también para quienes aceptaron. Los textos legales son globales y la seguridad por negocio (RLS) los ocultaba | Test nuevo del CSV ("acepta promociones" salía vacío) | Migración 0006: los textos globales se pueden leer desde cualquier negocio; modificarlos sigue reservado a la plataforma. Tests de RLS y de regresión |
| **De la semana 5:** en la búsqueda de clientes, una respuesta vieja que llegaba tarde (celular lento) **pisaba la búsqueda**: el dueño veía la lista general                                         | Falla intermitente de un E2E con login real           | Solo vale la respuesta de la última búsqueda. E2E con la respuesta vieja demorada: falla sin la corrección, pasa con ella                             |
| **Vacío previo:** los premios con días de vigencia no vencían nunca (no había trabajo programado)                                                                                                    | Revisión de la deuda #3                               | Vencimientos programados                                                                                                                              |
| **Vacío previo:** los logs de error podían incluir tokens de la URL y datos personales de las consultas                                                                                              | Revisión de hardening                                 | Logs sin tokens ni parámetros (tests)                                                                                                                 |
| **De esta semana:** la primera visita que además completaba la tarjeta mostraba la bienvenida y **ocultaba el aviso del premio**                                                                     | E2E nuevo de premio → canje                           | Si una operación deja varios mensajes, gana el más importante (test de regresión)                                                                     |
| **De esta semana:** el mensaje decía "Sumaste 1 sellos de regalo"                                                                                                                                    | Revisión de los textos                                | "Sumaste 1 de regalo"                                                                                                                                 |
| **Del entorno:** las 3 corridas seguidas de E2E chocaban con el límite local de 50 registros por IP (la protección funcionaba bien)                                                                  | Criterio "3 veces seguidas"                           | Límite **local** a 200 (`.env.example`); producción sin cambios                                                                                       |

## 6. Deuda técnica

**Cerradas esta semana:** #3 (vencimientos programados), #6 (prueba en celulares reales), #16 (PIN del dueño en caja).

**Se mantiene:**

| #   | Tema                                                                             | Semana                           |
| --- | -------------------------------------------------------------------------------- | -------------------------------- |
| 4   | Sincronización de cambios de regla y marca con los pases (`program.updated`)     | 7                                |
| 5   | Prueba real de Google Wallet en Android                                          | Cuando tengas la cuenta          |
| 7   | Límites de intentos en memoria (una sola instancia); ahora incluye exportaciones | 9                                |
| 8   | Turnstile (anti-bots) en el registro                                             | 9                                |
| 10  | Un solo checkbox para términos **y** privacidad                                  | Pendiente de tu validación legal |
| 13  | La página del QR de caja muestra el nombre del negocio (por diseño)              | —                                |
| 14  | Rutas de caja por `membershipId`                                                 | Documentado                      |
| 18  | Caja sin modo offline ([ADR 0004](./decisiones/0004-caja-requiere-conexion.md))  | Después del piloto               |
| 20  | Logos en disco local; en producción, R2/S3                                       | 9                                |
| 21  | Baja del cliente: aún no se avisa a Apple/Google                                 | 7–8                              |
| 24  | Configurar el TOTP del superadmin desde la interfaz                              | 9                                |
| 25  | Cambiar de plantilla solo antes del primer cliente (a propósito)                 | —                                |
| 26  | La meta de "< 15 minutos" falta medirla con una persona                          | Contigo / piloto                 |

**Nueva:**

| #   | Tema                                                                                              | Por qué se deja                                                  | Semana             |
| --- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------ |
| 27  | Túnel con nombre `dev.{dominio}`                                                                  | Falta comprar el dominio                                         | Al comprarlo       |
| 28  | El mensaje automático se ve en la tarjeta web; en el pase de Wallet, desde la semana 7            | El evento ya existe; falta el proveedor real                     | 7–8                |
| 29  | La caja de los E2E (cámara simulada) corre en un navegador propio y no entra en el control de CSP | El resto de las páginas sí; la caja usa los mismos recursos      | 9                  |
| 30  | La CSP de producción depende de publicar `dist/_headers` en el borde                              | El hosting se decide en la semana 9                              | 9                  |
| 31  | Android de gama baja real sin probar (sí el Samsung A22 de gama media-baja)                       | No se consiguió el equipo                                        | Piloto             |
| 32  | Los reportes se calculan al pedirlos                                                              | Volumen del piloto chico (milisegundos); si crece, se preagregan | Después del piloto |
| 33  | El umbral por defecto de "te falta poco" en puntos (10 % del premio) es una suposición            | Ajustable por negocio; confirmar con el piloto                   | Piloto             |

## 7. Cambios técnicos para la ingeniera

- **Migración nueva** `0006_consent_versions_lectura` (política de lectura de textos legales globales). Correr `pnpm db:migrate`.
- **Paquetes:** `pdf-lib` y `qrcode` en `@aiment/business`; `nodemailer` 10 (trae sus propios tipos; se quitó `@types/nodemailer`). `overrides` en `pnpm-workspace.yaml` para `esbuild` (vía drizzle-kit) y `source-map-js`.
- **API:** `GET /v1/orgs/:orgId/{reports, automations, exports/customers.csv, exports/movements.csv, branches/:branchId/counter.pdf}` y `PATCH /v1/orgs/:orgId/automations/:key`. Límites nuevos: `export` y `staffOverrideOrg`.
- **Núcleo:** `@aiment/core` → `automations.ts` (planificación pura y vigencia del mensaje). **Ledger:** `automations.ts` (ejecución en savepoint, retiro al anular y servicio del panel).
- **Worker:** `expirations.ts` (cola `loyalty.expire`, cron `7 * * * *`); `@aiment/ledger` pasa a dependencia del worker.
- **PWA:** `apps/web/security-headers.ts` (CSP y `_headers`), sección `panel/reports.tsx`, `panel/automations.tsx`, `downloadFile()` en `panel/shared.tsx`; la tarjeta muestra `card.message`.
- **Logs:** `redactPath()` y `safeError()` en `@aiment/config`.
- **E2E:** `e2e/fixtures.ts` (control de CSP), `apiAs()` y `membershipIdByShortCode()` en `e2e/helpers.ts`.
