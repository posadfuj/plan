# Semana 7 · Bloque 2: cambios del dueño y mensajes en el pase (modo simulado)

Fecha: 17/10/2026 · Estado: **terminado como integración simulada**, pendiente de tu aprobación. Como en el Bloque 1, lo real se confirma en la prueba con tus credenciales y un Android físico.

## 1. Qué quedó implementado

| Pieza                               | Qué hace                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cambio de marca**                 | Si el dueño cambia el nombre del negocio, el color o el logo (subirlo o quitarlo) en el panel, se actualiza el pase del negocio en Google (la clase). Google lo muestra en **todos los pases ya guardados**. Además se reenvía cada pase, porque el nombre aparece también en el mensaje. Solo se tocan los pases de ese negocio. |
| **Cambio de programa o regla**      | Nombre del programa, unidad ("sellos" → "cortes") o meta (10 → 6): se actualiza la clase y cada pase pasa a mostrar la regla nueva ("0 de 6 cortes · te faltan 6"). **Cierra la deuda #4.**                                                                                                                                       |
| **Mensaje automático en el pase**   | El pase muestra **el mismo mensaje vigente que la tarjeta web** (bienvenida, te falta poco, meta cumplida). Ahora los dos usan una sola regla: si el cliente canjea o se anula la visita, el mensaje desaparece de los dos. En una tarjeta pausada no se muestra.                                                                 |
| **Notificación al cumplir la meta** | "Meta cumplida" llega además como **notificación al celular** desde Google Wallet. Una sola vez por mensaje, aunque el evento se procese dos veces. Si se anuló la visita antes de avisar, no se avisa. Las otras automatizaciones solo actualizan el texto, sin notificar.                                                       |
| **Fallas de Google**                | Igual que en el Bloque 1: si Google está caído, se reintenta (primero la marca, después cada pase); si rechaza por datos o permisos, se anota y los pases se reenvían igual. La caja nunca se entera.                                                                                                                             |

## 2. Pruebas (todo en verde en local)

| Tipo                                    | Cantidad | Qué cubre                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unitarias nuevas                        | 3        | Cambio de marca en la clase (y no hace nada si nadie guardó un pase); mensaje en el pase (y no en una pausada); notificación única aunque se repita                                                                                                                                                                                         |
| Integración nuevas (worker + base real) | 3        | Nombre, color y logo desde las funciones reales del panel → clase actualizada, pases reenviados y **el otro negocio intacto**; nueva meta, nombre y unidad → los pases muestran la regla nueva; automatización real → mismo mensaje que la tarjeta, **una sola notificación** aunque se reprocesen los eventos, y anular la visita lo quita |
| **Total tests**                         | **326**  | Antes 320 (+6)                                                                                                                                                                                                                                                                                                                              |
| **E2E en celulares emulados**           | **32**   | Sin cambios (31 pasan + 1 omitida a propósito: Google en iPhone). Dos corridas seguidas en verde                                                                                                                                                                                                                                            |

Formato, lint y tipos, en verde. **CI:** verde en el [run #32](https://github.com/posadfuj/plan/actions/runs/39038715738). El run #31 había fallado en una prueba vieja del worker que esperaba un pase de la semilla exactamente en la versión 2; las pruebas nuevas, que en CI corren antes, ya lo habían sincronizado. Ahora compara contra la versión anterior (`648f866`).

Corriendo la integración en **orden aleatorio** apareció otra prueba vieja, ajena a Wallet, que depende del orden: la excepción de límite con el PIN del dueño en caja, donde a veces queda auditada otra persona del negocio con el mismo PIN. En el orden normal de CI pasa. Quedó como tarea aparte.

## 3. Pendiente para la prueba real (se suma a la del Bloque 1)

- [ ] Cambiar el color o el logo en el panel y ver el cambio en el pase guardado del Android.
- [ ] Completar la meta en caja y recibir la notificación de Google Wallet en el celular.

## 4. Deudas y riesgos

| #   | Riesgo o deuda                                                                                                                                                                        | Impacto                                            | Cuándo                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------- |
| 1   | Google pide `reviewStatus: UNDER_REVIEW` al editar una clase. En modo demo no importa; con el emisor publicado, un cambio de marca podría pasar por revisión de Google antes de verse | Demora en ver la marca nueva                       | Confirmar al publicar el emisor     |
| 2   | Google permite 3 notificaciones por pase cada 24 h. Hoy solo notifica "meta cumplida", así que no debería alcanzarse                                                                  | Si se alcanzara, el mensaje se ve sin notificación | Confirmar en la prueba real         |
| 3   | Un cambio de marca reenvía **cada** pase del programa (un job por pase). Con miles de pases tarda minutos y consume cuota de la API de Google                                         | Demora, no errores                                 | Revisar con datos reales (semana 9) |
| 4   | Agregar o cambiar premios del catálogo no reenvía los pases. El mensaje "te falta poco" se corrige en la siguiente operación del cliente                                              | Texto atrasado hasta la próxima visita             | Bajo; anotado                       |
| 5   | Apple sigue simulado: no tiene clase ni notificación (en Apple cada pase se reenvía entero)                                                                                           | —                                                  | Semana 8                            |

Siguen vigentes los riesgos del Bloque 1 que aceptaste (sección 4 de su reporte), menos el 3, que este bloque resolvió.

## 5. Dónde está el código

- `packages/wallet/src/message.ts`: el mensaje vigente, compartido entre la tarjeta web y el pase.
- `packages/wallet/src/google/`: `buildClassPatch` y el módulo de mensaje (`payload.ts`), `patchClass` y `addMessage` (`api.ts`, `simulated.ts`), `updateProgram` y `notify` (`provider.ts`).
- `apps/worker/src/outbox.ts` (eventos de marca, programa y notificación) y `wallet-sync.ts` (`syncProgram`, `notifyMembershipPasses`).
- `packages/business/src/settings.ts`: nombre, color y logo emiten `organization.branding_updated`.
