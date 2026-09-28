# Aiment Wallet: reporte de la semana 5

Fecha: 28/09/2026 · Alcance congelado: panel del dueño completo (marca, programa, clientes, trabajadores, dispositivos autorizados, sucursales y límites del plan) y el alta de negocios del panel maestro que ya estaba en el backlog de esta semana. No se agregaron funciones fuera del MVP.

## Resumen para decidir

| Pedido                                                      | Estado                                                                                                                                  |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Panel del dueño completo                                    | **Hecho.** 7 secciones: Inicio, Marca, Programa, Clientes, Equipo, Cajas, Sucursales                                                    |
| Restricción de trabajador por sucursal **con interfaz**     | **Hecho.** "¿En qué sucursales puede abrir turno?" al crear o editar; si se la quitas con un turno abierto, el turno se corta           |
| Límites del plan                                            | **Hecho.** Sucursales y trabajadores de caja, con mensaje claro para el dueño y uso visible ("2 de 3 trabajadores · plan Start")        |
| Caja necesita internet, sin modo offline                    | **Documentado** ([ADR 0004](./decisiones/0004-caja-requiere-conexion.md)) y visible: aviso en el panel y franja roja en la caja sin red |
| Un dueño configura y administra su negocio sin tocar código | **Confirmado en pruebas automáticas** (sección 1). Falta confirmarlo con una persona real y con celulares físicos                       |
| Prueba en celulares físicos (iPhone, Android medio y bajo)  | **No se pudo ejecutar desde este entorno** (sección 3). Queda lista para ti y **recomiendo hacerla antes de empezar la semana 6**       |

## 0. Ajustes pedidos al aprobar la semana 4

| Pedido                                                 | Qué se hizo                                                                                                                                                                                                |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mantener documentado que la caja necesita internet     | [ADR 0004](./decisiones/0004-caja-requiere-conexion.md): por qué no hay modo offline (duplicados, fraude, canjes dobles), cómo se comporta hoy (aviso, "Reintentar (no se duplica)") y el plan B del local |
| Restricción por sucursal con interfaz, no solo backend | Pantalla en **Equipo** + lista de la caja filtrada + corte del turno abierto al quitar la sucursal (antes el turno seguía vivo hasta vencer)                                                               |
| Prueba en celulares físicos antes o durante la semana  | Bloqueada por el entorno; checklist ampliado con el panel (P1–P11) y la caja sin red (C15)                                                                                                                 |

## 1. Demo

```bash
pnpm local:setup     # o, si ya lo tenías: pnpm local:down && pnpm local:up && pnpm local:env && pnpm db:reset
pnpm demo            # semana 5: panel de cero a la primera tarjeta + cliente + caja, en Android e iPhone emulados (18/18)
```

> Hay que reiniciar Supabase local una vez (`local:down` + `local:up`): el enlace de invitación del dueño ahora dura 24 horas (antes 1 hora).

**Recorrido "de cero a la primera tarjeta"** (lo hace la prueba en cada celular, todo por la interfaz):

1. **Panel maestro** (`/admin`, superadmin): crea "Lavandería Burbujas" con el rubro _Lavandería_ y el plan _Multi_. El negocio nace **en preparación** con su sede, su QR y el programa de la plantilla.
2. **Invitación**: le llega un correo a la dueña (Mailpit). El enlace abre el panel, pide **crear la contraseña** y no sirve dos veces.
3. **Inicio**: lista de lo que falta configurar, uso del plan y el aviso de que la caja necesita internet.
4. **Marca**: sube una **foto grande desde la galería** (1200 px) → el panel la achica a 512 px antes de subirla. Elige un amarillo pastel → aviso "los sellos se verán poco" y botón con un tono más oscuro sugerido. Frase, condiciones, teléfono e Instagram. **Vista previa** idéntica a la tarjeta real.
5. **Programa**: meta 6, bono de bienvenida de 1 sello, 60 minutos entre sumas, premio renombrado. La expiración aparece **desactivada** (piloto).
6. **Sucursales**: dirección de la sede y una **segunda sede** con su propio QR/NFC (2 de 10 del plan Multi).
7. **Equipo**: trabajadora **Rosa solo para Sede Norte** y PIN de la dueña.
8. **Aiment publica** el negocio (en preparación el QR no registra clientes ni se pueden autorizar cajas).
9. **Cajas**: QR para "Tablet Norte" en Sede Norte → la tablet queda autorizada → Rosa entra con su PIN. Con **modo avión**, franja roja "Sin conexión a internet".
10. **Cliente**: escanea el QR de Sede Norte → registro con la marca, frase y "Junta 6 sellos y gana: Lavado + secado gratis" → tarjeta con color, logo, condiciones y contacto.
11. **Primera visita** en caja → la tarjeta muestra 2 sellos (visita + bono).
12. **Clientes**: la dueña busca a la clienta, ve el historial con "Rosa", la **bloquea** (la tarjeta dice "pausada" y no muestra QR; la caja no deja sumar) y la desbloquea.
13. **Inicio**: "Configuración completa".

Tiempo del recorrido automatizado: **15 s (Android) y 13 s (iPhone)**. La meta del backlog (< 15 minutos) está pensada para una persona; ese tiempo real queda por medir contigo o con un piloto.

Además se prueba en Android e iPhone: **límites del plan Start** en la veterinaria ("Tu plan Start permite 1 sucursal", "de 3 trabajadores · plan Start").

Capturas: `e2e/artifacts/*-panel-*.png`. Te envío algunas con este reporte.

## 2. Qué quedó terminado

**Panel del dueño** (`/panel`, pensado primero para el celular):

| Sección    | Qué hace                                                                                                                                                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inicio     | Estado (en preparación / publicado), lista de configuración, números básicos, uso del plan y aviso de conexión de la caja                                                                                                                       |
| Marca      | Nombre, logo (PNG/JPG/WebP o foto del celular; se ajusta a 512 px), color con **chequeo de contraste** (texto siempre legible; aviso y sugerencia si los sellos se verían poco), frase, condiciones, contacto, vista previa                     |
| Programa   | Plantillas por rubro (8, solo antes del primer cliente), nombre y unidades, regla (por visita o por monto), meta, bienvenida (unidades o regalo), límites, expiración desactivada, premios (crear, editar, activar)                             |
| Clientes   | Lista con búsqueda (nombre, celular, código o correo), filtro (activos/bloqueados) y páginas; ficha con datos, saldo, premios, historial con quién atendió; ajuste con motivo, anular, bloquear, invalidar enlace, QR de recuperación, **baja** |
| Equipo     | Trabajadores con PIN y **sucursales**, editar, cambiar PIN, baja y reactivación (respeta el tope), PIN del dueño                                                                                                                                |
| Cajas      | Autorizar por sucursal con QR de un solo uso, quién está de turno, revocar                                                                                                                                                                      |
| Sucursales | Nombre y dirección, QR (PNG) y URL para NFC por sucursal, crear dentro del tope del plan, desactivar (su QR deja de registrar y sus cajas se cierran) y reactivar                                                                               |

**Panel maestro** (`/admin`, del backlog de esta semana): crear negocio (+ sucursal + programa desde plantilla + invitación al dueño), publicar (`draft → live`), suspender/reactivar, cambiar de plan, reenviar invitación, uso por negocio y auditoría de plataforma. Nunca muestra datos de clientes.

**Detalles importantes:**

- **Baja del cliente** (Ley 29733): se borran nombre, celular, correo, cumpleaños e IP/navegador de sus consentimientos; su tarjeta, su QR y sus enlaces de recuperación dejan de funcionar; el historial se conserva sin datos personales. Pide escribir **BAJA** para confirmar.
- **Bloqueo**: la tarjeta muestra "pausada, consulta en el local" (antes una tarjeta no activa daba "enlace no funciona" y el celular **olvidaba** el enlace, así que al desbloquear el cliente ya no la encontraba).
- **Correos con tildes o ñ** (deuda #9): `ñusta.peña@correo.pe` ya se acepta en el registro y en la marca.
- **Roles**: el admin gestiona marca, programa, clientes y equipo; solo el dueño ve la auditoría. El superadmin no entra al panel de un negocio.

## 3. Prueba en celulares físicos

**No se ejecutó.** Esta sesión corre en un contenedor en la nube cuya política de red **bloquea el túnel HTTPS** (`trycloudflare.com` responde 403), así que ningún teléfono puede llegar a la app que corre aquí. No tengo resultados de celulares reales y no los invento.

Para destrabarlo hay dos caminos:

1. **En tu computadora** (recomendado): `pnpm local:setup` + `pnpm local:tunnel` y la lista [`prueba-celulares.md`](./prueba-celulares.md): 12 pasos del cliente, 15 de caja (C1–C15) y **11 del panel (P1–P11)**, con columnas para iPhone, Android medio y Android bajo.
2. **En este entorno**: permitir `trycloudflare.com` en el acceso de red del entorno (menú del entorno en la barra de título de la sesión → Editar → acceso de red) y volver a intentarlo aquí.

Lo que la emulación **no** puede confirmar y ya se preparó en el código:

| Riesgo en celular real                                   | Qué se hizo                                                                              | Qué mirar en la prueba      |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------- |
| Fotos de varios MB y HEIC en iPhone                      | El panel achica la imagen en el celular antes de subirla; la API valida contenido        | P2 (galería y cámara)       |
| Safari real: cámara, permisos y lector de QR de respaldo | Sin cambios desde la semana 4                                                            | C6 con poca luz             |
| Pérdida de señal en la caja                              | Franja roja inmediata + reintento sin duplicar                                           | C15 (modo avión)            |
| Android de gama baja: velocidad del panel                | El panel se descarga aparte (~73 kB comprimido); la tarjeta del cliente sigue en ~111 kB | P11 y tiempos de caja (C13) |

**Tu criterio:** si aparece una diferencia importante respecto de la emulación, se corrige antes de avanzar. Como la prueba no pudo hacerse, **recomiendo no iniciar la semana 6 hasta tener esos resultados** (o iniciarla sabiendo que las correcciones que salgan tendrán prioridad).

## 4. Resultados de pruebas

| Suite                                  | Tests   | Qué cubre                                                                                                                                                      |
| -------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unitarias                              | 59      | + contraste y marca (13), plantillas por rubro válidas, validación de imágenes y rutas de archivos                                                             |
| Integración: **panel (nueva)**         | 31      | El recorrido completo por HTTP: alta, invitación, marca y logo, plantillas, reglas, sucursales, topes, trabajador por sucursal, caja, bloqueo, URL, baja, plan |
| Integración: API (aislamiento y roles) | 22      | Ahora **41 rutas** de negocio en la suite de aislamiento (+17)                                                                                                 |
| Integración: caja                      | 28      | Sin cambios de comportamiento                                                                                                                                  |
| Integración: flujo público             | 26      | Sin cambios                                                                                                                                                    |
| Integración: ledger                    | 38      | Sin cambios                                                                                                                                                    |
| Integración: base de datos (RLS)       | 15      | Sin tablas nuevas (no hubo migración)                                                                                                                          |
| Integración: Wallet/worker             | 7       | Sin cambios                                                                                                                                                    |
| **Subtotal**                           | **226** | Antes 182. Cobertura del motor: 99 % (CI exige 90 %)                                                                                                           |
| **E2E en celulares emulados**          | **18**  | 4 del cliente + 3 de caja + **2 del panel**, en Android (Pixel 7) e iPhone (14)                                                                                |

**Novedad en CI:** los E2E del panel ya **no se omiten** en GitHub Actions. Sin Supabase Auth, la prueba guarda en el navegador una sesión firmada igual que la de Supabase y crea el negocio con el mismo servicio del panel maestro. Localmente corren con login e invitación reales. Pasan 18/18 en los dos modos.

**Seguridad del panel, verificada con pruebas:**

| Qué              | Cómo                                                                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aislamiento      | El dueño de otro negocio recibe 404 en las 41 rutas (marca, logo, sucursales, clientes, bloqueo, baja, equipo…) y la base de A queda idéntica         |
| Logo             | Se valida por **contenido** (PNG, JPG, WebP); SVG (puede llevar scripts) → 415; más de 1 MB → 413; se sirve con `nosniff` y CSP; rutas con `..` → 404 |
| Invitación       | Código de un solo uso, 24 h; se quita de la barra de direcciones; sin clave de Supabase configurada no se crea nada (503 claro)                       |
| Baja             | Sin datos personales en cliente, consentimientos ni auditoría; tarjeta, QR y recuperación sin efecto; ledger intacto                                  |
| Topes            | Dos altas simultáneas no pasan el tope (la fila del negocio se bloquea dentro de la transacción)                                                      |
| Turno y sucursal | Quitarle la sucursal a un trabajador corta su turno en la siguiente acción                                                                            |

## 5. Bugs encontrados y corregidos

| Bug                                                                                                                                                                    | Cómo se detectó                        | Corrección                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------- |
| Con colores de marca de tono medio (grises, celestes), el texto del encabezado quedaba en 4,48:1, por debajo del mínimo AA (4,5)                                       | Test unitario nuevo de contraste       | Texto negro puro en lugar de gris muy oscuro: siempre ≥ 4,58:1                |
| Si el dueño cambiaba la sucursal de un trabajador, su turno abierto en la otra sucursal seguía válido hasta 12 h                                                       | Revisión del diseño + test             | El turno revisa la sucursal en cada acción y se cierra al cambiarla           |
| Bloquear a un cliente hacía que su tarjeta dijera "este enlace ya no funciona" y el celular borrara el enlace guardado: al desbloquear, el cliente ya no la encontraba | Revisión del flujo de bloqueo          | La tarjeta bloqueada abre, dice "pausada" y oculta el QR                      |
| Al guardar la regla del programa, el formulario se recargaba con la versión nueva y el mensaje "Regla guardada" desaparecía al instante                                | E2E del panel                          | La confirmación se muestra a nivel de la sección                              |
| El tope de trabajadores daba error 500: Postgres no acepta `FOR UPDATE` sobre una consulta con el esquema en el nombre                                                 | Suite de caja (antes de publicar nada) | Bloqueo en una consulta separada                                              |
| El validador rechazaba correos con tildes o ñ (deuda #9)                                                                                                               | Deuda de la semana 3                   | Validación propia que acepta letras de cualquier idioma                       |
| La cobertura del motor bajó a 88 % por las funciones nuevas de marca                                                                                                   | Mismo chequeo que CI                   | Tests de lectura de la marca guardada (datos viejos, basura, claves de logo)  |
| El enlace de invitación vencía en 1 hora                                                                                                                               | Revisión                               | 24 horas (`supabase/config.toml`) + "Reenviar invitación" en el panel maestro |

## 6. Deuda técnica pendiente

**Cerradas esta semana:** #9 (correos con tildes/ñ), #15 (tope de trabajadores del plan), #17 (pantalla de sucursal por trabajador), #19 (panel completo). #18 (caja sin conexión) queda **documentada** en el ADR 0004 y se revisa después del piloto.

**Se mantiene:**

| #   | Tema                                                                            | Semana                           |
| --- | ------------------------------------------------------------------------------- | -------------------------------- |
| 3   | Job de expiración programado                                                    | 6                                |
| 4   | Sincronización de cambios de regla y marca con los pases (`program.updated`)    | 7                                |
| 5   | Prueba real de Google Wallet en Android                                         | Cuando tengas la cuenta          |
| 6   | **Prueba en celulares reales** (cliente, caja y ahora panel)                    | Tú, antes de la semana 6         |
| 7   | Límite de intentos en memoria (una sola instancia)                              | 9                                |
| 8   | Turnstile (anti-bots) en el registro                                            | 9                                |
| 10  | Un solo checkbox para términos **y** privacidad                                 | Pendiente de tu validación legal |
| 12  | Tailwind sin shadcn/ui: el panel se hizo con componentes propios simples        | Propongo cerrarla (ver abajo)    |
| 13  | La página del QR de caja muestra el nombre del negocio (por diseño)             | —                                |
| 14  | Rutas de caja por `membershipId`                                                | Documentado                      |
| 16  | Intentos del PIN del dueño en caja limitados por dispositivo                    | 6 (hardening)                    |
| 18  | Caja sin modo offline ([ADR 0004](./decisiones/0004-caja-requiere-conexion.md)) | Después del piloto               |

**Nueva:**

| #   | Tema                                                                                                                                     | Por qué se deja                                                                           | Semana           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------- |
| 20  | Los logos se guardan en disco local (`.data/storage`); en producción, R2/S3                                                              | La interfaz ya existe; falta el conector al publicar. Los logos reemplazados no se borran | 9                |
| 21  | Al dar de baja a un cliente, sus pases de Wallet se marcan revocados y se emite `membership.closed`, pero aún no se avisa a Apple/Google | Los proveedores reales llegan en las semanas 7–8                                          | 7–8              |
| 22  | Invitar administradores (rol admin) desde el panel                                                                                       | No estaba en el backlog del MVP; hoy lo hace Aiment directamente en la base               | Tu decisión      |
| 23  | Corregir nombre o celular de un cliente desde la ficha                                                                                   | No estaba en el backlog; hoy se hace con baja + nuevo registro o con soporte              | Tu decisión      |
| 24  | Configurar el TOTP del superadmin desde la interfaz (hoy solo se verifica el código)                                                     | En local el TOTP no es obligatorio; en producción se configura una vez                    | 9                |
| 25  | Cambiar de plantilla (sellos ↔ puntos) solo antes del primer cliente                                                                     | Con clientes cambiaría el valor de lo ya ganado. Es a propósito                           | —                |
| 26  | La meta de "< 15 minutos" se midió con la prueba automática (13–15 s), no con una persona                                                | Requiere una persona real                                                                 | Contigo / piloto |

**Sobre la #12 (shadcn/ui):** el panel quedó con un conjunto chico de componentes propios (botones, campos, tarjetas, etiquetas) sobre Tailwind, consistente con la tarjeta y la caja. Incorporar shadcn/ui ahora agregaría dependencias sin cambio visible para el dueño. **Propongo cerrarla** y dejar la decisión de diseño para cuando haya diseñador; si prefieres mantener shadcn/ui en la arquitectura, lo agendo.

## 7. Cambios técnicos para la ingeniera

- **Sin migración nueva.** Marca y contacto viven en `organizations.branding` (jsonb, leído con `readBranding` en `@aiment/core`). Hay que reiniciar Supabase local una vez por el vencimiento de la invitación.
- **Paquetes nuevos:** `@aiment/business` (marca, logo, sucursales, clientes, topes del plan, panel maestro) y `@aiment/storage` (interfaz de archivos: disco local y memoria; R2 en la semana 9).
- **API:** `/v1/orgs/:orgId/{settings,settings/logo,program,program/template,branches,customers/*,memberships/:id/{block,unblock,rotate-card},team/:id}` y `/v1/admin/{orgs,orgs/:id/{activate,invite,plan},plans,audit}`. Público: `/v1/public/files/logos/…`. Permiso nuevo `branches.manage` (dueño y admin).
- **Invitaciones:** `apps/api/src/auth/admin.ts` usa la API de administración de Supabase (`SUPABASE_SECRET_KEY`, solo servidor) para generar el código; el correo lo envía Aiment Wallet. La PWA lo canjea en `/panel/acceso`.
- **PWA:** `apps/web/src/panel/` (una sección por archivo), `/panel/:seccion`, `/panel/acceso`, `/admin`. La tarjeta del cliente es un componente (`CardView`) que usa también la vista previa del panel.
- **Datos de prueba:** la barbería pasa al plan **Pro** (10 trabajadores); la veterinaria sigue en **Start** (1 sucursal, 3 trabajadores) para probar los topes.
- **Variables nuevas:** `STORAGE_DIR` (opcional, por defecto `.data/storage`).
