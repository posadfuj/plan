# Aiment Wallet: reporte de la semana 4

Fecha: 28/09/2026 · Alcance congelado: modo trabajador (PIN de trabajador, dispositivo autorizado y flujo de caja), más los ajustes pedidos al aprobar la semana 3. No se agregaron funciones fuera del MVP.

## 0. Ajustes pedidos al aprobar la semana 3

| Pedido                                                    | Qué se hizo                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cumpleaños en formato dd/mm/aaaa                          | El campo ya no usa el calendario del navegador: se escriben solo números y la pantalla pone las barras (`07/03/1991`). La API acepta dd/mm/aaaa, valida fechas imposibles (31/02) y guarda la fecha normal. Diseño sin cambios                                                          |
| Botones de Apple/Google "Próximamente"                    | Cada botón muestra la etiqueta **Próximamente** visible (antes solo aparecía al pasar el mouse), sigue desactivado y el texto de abajo dice "Muy pronto podrás guardarla en tu Wallet"                                                                                                  |
| Términos y privacidad                                     | **Sin cambios**, pendiente de tu validación legal. El consentimiento de promociones sigue separado y opcional                                                                                                                                                                           |
| Token privado de la tarjeta: hash y rotación              | **Implementado** ([ADR 0002](./decisiones/0002-token-de-tarjeta-con-hash.md)). La base guarda solo el hash de la URL de la tarjeta; al recuperar la tarjeta (correo o caja) se entrega una URL **nueva** y la anterior deja de funcionar. Las tarjetas ya entregadas siguen funcionando |
| Límites por IP para producción (clientes con la misma IP) | **Rediseñados** ([ADR 0003](./decisiones/0003-limites-de-intentos.md)): por IP quedan holgados (solo frenan ráfagas) y el control fino va por celular/contacto dentro del negocio y por dispositivo de caja. Probado: 12 clientes desde la misma IP se registran sin bloqueo            |
| Prueba en celulares físicos                               | Lista ampliada con la caja: [`prueba-celulares.md`](./prueba-celulares.md) (cámara, recuperación, QR/NFC, iPhone y Android). Ver sección 3                                                                                                                                              |

## 1. Demo

```bash
pnpm local:setup     # la primera vez (o pnpm db:reset si ya lo tenías: hay una migración nueva)
pnpm demo            # semana 4: caja + flujo del cliente en Android e iPhone emulados (14/14)
pnpm local:tunnel    # para probar tú en celulares reales
```

La demo recorre en cada celular:

1. **Dispositivo sin autorizar**: `/caja` no abre y explica cómo autorizarlo.
2. **El dueño autoriza el dispositivo** desde el panel (Caja → Generar QR); la tablet lo escanea y queda autorizada. El mismo QR no sirve dos veces.
3. **Turno**: "¿Quién atiende?" → Jhon (caja) → PIN con teclado grande → pantalla de caja.
4. **ESCANEAR CLIENTE con la cámara**: la caja tiene una cámara simulada que "ve" el QR de la tarjeta del cliente (el mismo código que muestra su pantalla) y abre su ficha.
5. **Sumar visita** → "+1 sello"; la tarjeta del cliente se actualiza.
6. **Sumar otra vez el mismo día** → "Este cliente ya sumó hace poco" → motivo + PIN del dueño. Un PIN equivocado se rechaza; el correcto autoriza y queda auditado quién lo autorizó.
7. **Anular** el último movimiento con un motivo de un toque.
8. **Buscar** por el código de 6 letras de la tarjeta (cuando la cámara falla).
9. **Recuperación en caja**: QR de un solo uso; el cliente lo escanea con su celular nuevo y la URL anterior deja de funcionar.
10. **Cerrar turno**.

Capturas: `e2e/artifacts/*-caja-*.png` (Android e iPhone). Te envío algunas con este reporte.

### Tiempos por operación (Android de gama media simulado: CPU 4× más lenta y red móvil)

| Operación                                              | Android | iPhone |
| ------------------------------------------------------ | ------- | ------ |
| Escanear → ficha del cliente (incluye abrir la cámara) | 2,5 s   | 2,4 s  |
| Sumar visita → confirmación                            | 0,4 s   | 0,3 s  |
| Excepción con PIN del dueño                            | 0,7 s   | 1,1 s  |
| Anular (con motivo)                                    | 0,3 s   | 0,4 s  |
| Buscar por código                                      | 0,6 s   | 0,5 s  |

Meta: menos de 5 s por operación. La prueba falla si alguna la supera. Falta confirmarlo con un celular real (sección 3).

## 2. Resultados de pruebas

| Suite                                  | Tests   | Qué cubre                                                                                                                         |
| -------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Unitarias                              | 46      | + PIN (argon2id, 4–6 dígitos, rechaza 1234/1111/9876), permisos de caja y mensaje de anulación                                    |
| Integración: **caja (nueva)**          | 28      | Dispositivo, cookies, PIN y bloqueo, turnos, escaneo y búsqueda, sumar/canjear/anular, excepciones, recuperación, **aislamiento** |
| Integración: flujo público             | 26      | + hash y rotación de la URL, cumpleaños dd/mm/aaaa, límites con IP compartida y por celular/contacto                              |
| Integración: API (aislamiento y roles) | 22      | Ahora **24 rutas** de negocio en la suite de aislamiento (+7: equipo y dispositivos)                                              |
| Integración: ledger                    | 38      | + anular una visita anterior a la que completó la meta                                                                            |
| Integración: base de datos (RLS)       | 15      | Detecta y cubre la tabla nueva `device_pairings`                                                                                  |
| Integración: Wallet/worker             | 7       | Sin cambios                                                                                                                       |
| **Subtotal**                           | **182** | Estable en 3 corridas seguidas                                                                                                    |
| **E2E en celulares emulados**          | **14**  | 4 del cliente + 3 de caja, en Android (Pixel 7) e iPhone (14)                                                                     |

**Seguridad de la caja, verificada con pruebas:**

| Qué                        | Cómo                                                                                                                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aislamiento entre negocios | Con el dispositivo de la barbería, un cliente del café no se lee ni se opera (QR, ficha, sumar, canjear, anular, recuperación → 404) y la base queda igual. Un trabajador de otro negocio no puede abrir turno |
| Cookies                    | `httpOnly`, `SameSite=Strict`, solo para `/v1/staff`; `Secure` cuando la URL es https. Dispositivo 180 días; turno 12 horas                                                                                    |
| Secretos                   | En la base solo hay hashes: secreto del dispositivo, token del turno, código de autorización, URL de la tarjeta y PIN (argon2id)                                                                               |
| PIN                        | 5 intentos → bloqueo de 15 min (aunque luego se escriba bien), auditado; el dueño desbloquea cambiando el PIN                                                                                                  |
| Revocación                 | Revocar un dispositivo o dar de baja a un trabajador corta el acceso en la siguiente acción. Un turno por dispositivo; la cookie de turno no sirve en otro                                                     |
| Anulación                  | El trabajador solo anula su último movimiento, dentro de 15 min; el dueño en caja puede anular cualquiera                                                                                                      |
| Excepciones                | Solo con PIN del dueño o de un admin (el PIN de un trabajador no sirve), con motivo y auditadas con quién autorizó y desde qué dispositivo                                                                     |
| Idempotencia               | Un reintento por mala señal con la misma clave no duplica la suma                                                                                                                                              |

**CI:** se completa al subir (ver sección 6).

## 3. Prueba en celulares reales

Sigue **pendiente de ti**: el entorno de esta sesión bloquea el túnel HTTPS, así que ningún teléfono puede llegar a la app que corre aquí. Para la prueba que planeas al inicio de la semana 5:

- `pnpm local:tunnel` en tu computadora y la lista [`prueba-celulares.md`](./prueba-celulares.md): 12 pasos del cliente + **14 de caja** (C1–C14), con columnas para iPhone, Android medio y Android bajo.
- Lo que la emulación **no** puede confirmar y conviene mirar con atención: Safari real en iPhone (cámara y permisos), el lector nativo de QR de Chrome en Android (en la emulación se usa el lector de respaldo), poca luz y pantallas con brillo bajo, NFC real y datos móviles.
- La cámara solo abre por `https://` (túnel) o `localhost`: por la IP del Wi-Fi no funciona.

## 4. Qué quedó terminado

- **Dispositivo autorizado:** QR de un solo uso (10 min) desde el panel, cookie de 180 días, lista de dispositivos con quién está de turno y revocación.
- **Trabajadores con PIN:** alta, cambio de PIN, baja; PIN del dueño/admin para excepciones. Login en caja con nombre + PIN, bloqueo por intentos, turno de 12 h y "Cerrar turno".
- **Caja:** ESCANEAR CLIENTE (lector nativo del navegador y respaldo zxing-wasm servido desde la app, sin CDN), búsqueda por celular o código, ficha del cliente, sumar (con importe en puntos), canjear premios ganados y de catálogo, anular (último movimiento, 15 min, motivo de un toque), excepción con PIN del dueño y QR de recuperación.
- **Bono de bienvenida** en la 1.ª visita validada en caja (nunca al registrarse), probado.
- **Mensaje de anulación** (deuda #2): "Esta visita ya cuenta para un premio que se completó después. Anula primero la visita que completó la meta".
- **UX:** botones de 56 px o más (verificado en la prueba), teclado de PIN grande, confirmación antes de canjear, "Reintentar (no se duplica)" si se corta la señal.
- La caja se descarga aparte: la tarjeta del cliente sigue pesando 110 kB comprimida.

## 5. Bugs encontrados y corregidos

| Bug                                                                                                                                           | Cómo se detectó             | Corrección                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------- |
| Con el límite por IP de la semana 3, el 6.º cliente de un local (misma IP) quedaba bloqueado                                                  | Tu observación + test nuevo | Límites rediseñados (ADR 0003)                                                                |
| El límite de autorización de dispositivos bloqueaba pruebas repetidas en local                                                                | E2E repetido (429)          | Configurable como los demás (`RATE_LIMIT_DEVICE_PAIR`); en producción queda en 10 cada 10 min |
| En desarrollo, React monta la pantalla dos veces y habría gastado el QR de autorización (es de un solo uso)                                   | Revisión del código         | La pantalla lo usa una sola vez                                                               |
| El primer escaneo en iPhone esperaba la descarga del lector de respaldo                                                                       | Medición de tiempos         | El lector se precarga al abrir el turno                                                       |
| La confirmación decía "+1 sellos"                                                                                                             | Revisión de capturas        | "+1 sello" / "+2 sellos"                                                                      |
| Prueba de suspensión suponía que la auditoría del negocio estaba vacía; la de registros simultáneos chocaba con el límite por celular         | Suite completa              | Las pruebas miran solo lo suyo / usan un límite propio                                        |
| La cámara simulada no abría si la ruta del video tenía tildes ("límites"); la demo de la semana 3 apuntaba a una carpeta en vez del navegador | E2E / demo                  | Ruta sin tildes; la demo encuentra el navegador instalado                                     |

## 6. Deuda técnica pendiente

**Se mantiene:**

| #   | Tema                                                                        | Semana                           |
| --- | --------------------------------------------------------------------------- | -------------------------------- |
| 3   | Job de expiración programado                                                | 6                                |
| 4   | Sincronización de cambios de regla con los pases (`program.updated`)        | 7                                |
| 5   | Prueba real de Google Wallet en Android                                     | Cuando tengas la cuenta          |
| 6   | **Prueba en celulares reales**                                              | Tú, con `pnpm local:tunnel`      |
| 7   | Límite de intentos en memoria (una sola instancia)                          | 9                                |
| 8   | Turnstile (anti-bots) en el registro                                        | 9                                |
| 9   | El validador rechaza correos con tildes o ñ antes de la @                   | 5                                |
| 10  | Un solo checkbox para términos **y** privacidad (se registran por separado) | Pendiente de tu validación legal |
| 12  | Tailwind sin shadcn/ui                                                      | 5                                |
| 13  | La página del QR de caja muestra el nombre del negocio (por diseño)         | —                                |

**Cerradas esta semana:** #1 (PIN y dispositivo), #2 (mensaje de anulación), #11 (URL de la tarjeta en claro).

**Nueva:**

| #   | Tema                                                                                    | Por qué se deja                                                                                                   | Semana             |
| --- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------ |
| 14  | Rutas de caja por `membershipId` (la arquitectura decía por `scanToken`)                | La búsqueda por celular devuelve la membresía sin QR; el negocio sale del dispositivo, así que es igual de seguro | Documentado        |
| 15  | No se aplica el tope de trabajadores del plan (`plans.limits.staff`)                    | Es parte de planes y facturación                                                                                  | 5 (panel) / 9      |
| 16  | Los intentos fallidos de PIN del dueño en caja se limitan por dispositivo, no por dueño | Sin nombre no se sabe de quién es el intento; 10 cada 15 min por dispositivo                                      | 6 (hardening)      |
| 17  | Restricción de trabajador por sucursal: la regla existe, falta la pantalla              | Hoy cada negocio tiene una sucursal                                                                               | 5                  |
| 18  | La caja necesita conexión (sin modo offline)                                            | Operar sin conexión arriesga duplicados y fraude; se evalúa con el piloto                                         | Después del piloto |
| 19  | Panel de caja mínimo (dispositivos, equipo, PIN)                                        | La pantalla completa de trabajadores y dispositivos es de la semana 5                                             | 5                  |

## 7. Cambios técnicos para la ingeniera

- Migración `0005_caja_y_token_hash`: `device_pairings` (con RLS), `staff_sessions.token_hash`, `worker_devices.device_secret_hash` único y `memberships.web_card_token` → `web_card_token_hash` (convierte los existentes). Correr `pnpm db:reset` en local.
- Paquete nuevo `@aiment/staff` (dispositivos, turnos, PIN, equipo, ficha de caja). La caja usa el mismo `@aiment/ledger` que el panel.
- API: `/v1/staff/*` (cookies) y `/v1/orgs/:orgId/{team,devices}`. Actor nuevo `register` en la matriz de permisos: en caja solo se opera, aunque entre el dueño.
- PWA: `/caja` y `/caja/vincular/:code` (descarga aparte), panel con sección Caja.
- Datos de prueba: PIN de trabajadores `2580`, PIN de dueños/admin `1470`.
