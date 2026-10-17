# Semana 7 · Bloque 1: Google Wallet (modo simulado)

Fecha: 17/10/2026 · Estado: **terminado en modo simulado**. Falta la prueba real en Android, que necesita tus credenciales de Google. Después de esa prueba se aprueba el bloque y se pasa al Bloque 2.

## 1. Qué quedó implementado

| Pieza                                   | Qué hace                                                                                                                                                                                                                                                                                        |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pase del negocio** (clase de Google)  | Una por programa: nombre del negocio, nombre del programa, logo y color de marca. El id es opaco (no expone ids internos) y cambia si cambia la cuenta emisora.                                                                                                                                 |
| **Pase del cliente** (objeto de Google) | Uno por cliente: sellos o puntos (con la meta), premios por canjear, nombre corto ("Gabriela R."), progreso ("7 de 10 sellos · te faltan 3") y el **mismo QR de caja** que la tarjeta web.                                                                                                      |
| **Logo**                                | Usa el logo del negocio si es PNG o JPG. Si no hay logo, o es WebP (Google no lo acepta), usa un logo genérico de Aiment.                                                                                                                                                                       |
| **Botón "Agregar a Google Wallet"**     | **Solo en Android**, como decidiste. En iPhone se ve "Apple Wallet · Próximamente" (llega en la semana 8). En computadora no hay botones. La tarjeta web funciona siempre.                                                                                                                      |
| **Enlace del botón**                    | Lo arma el servidor firmando con la cuenta emisora, **sin llamar a Google**: el botón funciona aunque la API de Google esté caída. Tocarlo varias veces (incluso a la vez) da siempre el mismo pase. Máximo 20 enlaces por tarjeta cada 10 minutos.                                             |
| **Actualización automática**            | Después de sumar, canjear, ajustar, anular, vencer, editar el nombre o pausar la tarjeta, el worker envía el estado actual de la base. Si el cliente abrió el enlace pero no tocó "Guardar", el pase se crea en Google con el saldo al día.                                                     |
| **Tarjeta pausada**                     | El pase muestra "Tarjeta pausada" en lugar del QR, y no se entregan enlaces nuevos. Al reactivarla, vuelve el QR.                                                                                                                                                                               |
| **Cliente eliminado**                   | El pase queda inactivo en Google, **sin nombre ni QR**, con el texto "Tarjeta cerrada".                                                                                                                                                                                                         |
| **Fallas de Google**                    | La caja y el ledger nunca esperan a Google. Si Google está caído, se reintenta (hasta 8 veces, con espera creciente de hasta 1 hora). Si Google rechaza por datos o permisos, se anota en el pase y **no** se reintenta en bucle.                                                               |
| **Simulado → real**                     | Es solo configuración (`GOOGLE_WALLET_MODE=auto`). Con el Issuer ID, `secrets/google-wallet-sa.json` y una dirección https (túnel), la API y el worker pasan a Google real solos. Con `live`, si falta algo, no arrancan y dicen qué falta. Al arrancar, cada proceso muestra en qué modo está. |
| **Vista simulada**                      | Mientras tanto, el botón abre `/wallet/google-simulado`, que muestra el pase tal como lo recibiría Google. El pase viaja en la parte de la URL después de `#`, que nunca llega a ningún servidor.                                                                                               |

El proveedor es el **mismo código** en simulado y en real. Lo único que cambia es el cliente de la API de Google: uno en memoria, que imita las respuestas de Google (404, 409, caídas), o el HTTP real con OAuth de la cuenta de servicio.

## 2. Pruebas (todo en verde)

| Tipo                               | Cantidad | Qué cubre                                                                                                                                                                                                                                                                                                               |
| ---------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unitarias del pase y del proveedor | 11       | Contenido del pase, enlace simulado y real, reutilizar el pase, logo por defecto, clase por programa, pausa y reactivación, crear si no lo guardó, Google caído vs. rechazo, cierre al eliminar                                                                                                                         |
| Unitarias del cliente HTTP real    | 4        | Token OAuth con la cuenta de servicio (y su reutilización), renovación ante 401, qué errores se reintentan y cuáles no, credenciales rechazadas                                                                                                                                                                         |
| Unitarias de configuración         | 5        | `auto` sin credenciales → simulado; con credenciales y https → real; sin https → simulado; `live` incompleto → no arranca; `simulated` / `off`                                                                                                                                                                          |
| Integración del worker (base real) | 9        | Caja → pase: sumar, meta, canje, ajuste y anulación; abrió y no guardó; **Google caído: la caja suma igual y el pase se pone al día al volver**; rechazo 403 sin bucle; pausa; cliente eliminado; un solo pase aunque se pida a la vez; **aislamiento: cada negocio con su clase y su marca**; cambio de cuenta emisora |
| Integración de la API del botón    | 4        | Sin Google → sin botón; con Google → enlace con marca, saldo y QR (sin el token privado de la tarjeta), siempre el mismo pase; tokens inválidos o del QR de caja → 404; pausada → 409; límite por tarjeta                                                                                                               |
| **Total tests**                    | **320**  | Antes 287 (+33)                                                                                                                                                                                                                                                                                                         |
| **E2E en celulares emulados**      | **32**   | Antes 30. Android: botón → pase simulado con marca, saldo, nombre y el mismo QR de caja. iPhone: solo Apple "Próximamente", sin botón de Google. La prueba de Google se omite en iPhone a propósito (31 pasan + 1 omitida)                                                                                              |

Corrido localmente contra el build de producción con la CSP puesta, igual que en CI. Las pruebas en celulares pasaron dos veces seguidas después de `db:reset`. Formato, lint y tipos, en verde.

## 3. Pendiente solo por las credenciales reales

1. **Tu parte:** el Issuer ID, el archivo `secrets/google-wallet-sa.json` (sin pegarlo en el chat) y los correos de Google de los Android de prueba, agregados como usuarios de prueba del emisor.
2. **Mi parte:** levantar el túnel (alcanza el temporal; **el dominio no hace falta todavía**), confirmar que la API y el worker digan "Google Wallet REAL" y probar en Android:
   - guardar el pase;
   - sumar en caja y ver el pase actualizarse;
   - pausar la tarjeta, reactivarla y escanear el QR del pase en la caja.
3. **Cosas que solo se confirman contra Google real:**
   - que el enlace no sea demasiado largo (unos 2 KB);
   - cómo muestra Google el texto "Tarjeta pausada" en lugar del QR;
   - que Google descargue el logo por el túnel;
   - la marca de "prueba" del modo demo (es lo esperado).

## 4. Fuera de este bloque (Bloque 2 o después)

- Si el dueño cambia la regla, la meta, el color o el logo, actualizar la clase y todos los pases (deuda #4).
- Mostrar en el pase el mensaje automático, con notificación al cumplir la meta.
- Imagen con los sellos dibujados (necesita alojar imágenes públicas: túnel con nombre o R2).
- Botón oficial de Google ("Add to Google Wallet"), que se pide al solicitar la publicación del emisor.

## 5. Decisiones que necesito de ti

Ninguna bloqueante. Solo confirmar dos cosas:

- **En computadora no aparece ningún botón de Wallet**, solo el texto "Abre esta tarjeta en tu celular para guardarla en tu Wallet". Lo apliqué siguiendo "Google solo en Android".
- **En la vista previa del panel** el dueño sigue viendo los dos botones como "Próximamente", para que sepa qué verán sus clientes en cada celular.

## 6. Dónde está el código

- `packages/wallet/src/google/`: contenido del pase (`payload.ts`), API real y simulada (`api.ts`, `simulated.ts`), proveedor (`provider.ts`) y configuración (`config.ts`).
- `packages/wallet/src/passes.ts`: enlace del botón, un pase por cliente.
- `apps/worker/src/`: colas por proveedor, reintentos y cierre de pases.
- `apps/api/src/routes/public.ts`: `POST /v1/public/cards/:token/wallet/google`.
- `apps/web/src/components/card-view.tsx` (botones por celular) y `apps/web/src/routes/wallet-sim.tsx` (vista simulada).
- Operación: `docs/runbook.md`, sección 9.
