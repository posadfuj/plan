# ADR 0004: la caja necesita conexión a internet (sin modo offline en el MVP)

- **Estado:** aceptada (semana 5, confirmada por el fundador al aprobar la semana 4); se revisa con los datos del piloto
- **Contexto:** la caja corre en el navegador de un celular o tablet del local. Si se corta la señal, una opción sería guardar las operaciones en el celular y enviarlas después (modo offline). En el MVP no se hace.

## Decisión

La caja **solo opera con conexión** (Wi-Fi o datos móviles). Toda suma, canje, anulación o excepción se confirma en el servidor, dentro de una transacción, antes de mostrar "+1 sello".

## Por qué

| Riesgo de un modo offline         | Qué pasaría                                                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Duplicados                        | Dos cajas sin señal suman al mismo cliente; al volver la red, las reglas (cooldown, meta) ya no se pueden aplicar en orden |
| Fraude                            | Un celular sin conexión no puede validar un turno revocado, un trabajador dado de baja ni el PIN del dueño en tiempo real  |
| Canjes dobles                     | El mismo premio se entrega en dos cajas antes de sincronizar                                                               |
| Saldo inconsistente en la tarjeta | El cliente ve un saldo distinto al del local hasta que sincronice                                                          |

El ledger es la fuente de verdad (regla madre de la arquitectura): una operación existe solo si el servidor la registró.

## Cómo se comporta hoy

- **Aviso inmediato:** si el celular pierde la red, la caja muestra una franja roja "Sin conexión a internet: la caja no puede sumar ni canjear" (probado en E2E con el celular emulado sin red).
- **Reintento seguro:** si la señal se corta en medio de una operación, la caja ofrece "Reintentar (no se duplica)": la misma clave de idempotencia garantiza que el servidor no la registre dos veces.
- **Documentado para el dueño:** el panel (Inicio y Cajas) avisa que la caja necesita internet.
- **Plan B del local:** anotar la visita y cargarla después desde el panel con **Ajustar saldo** (queda con motivo y auditada).

## Cuándo se revisa

Después del piloto (semana 10), con datos de cuántas operaciones fallaron por falta de señal. Si fuera necesario, la alternativa preferida es una **cola local de solo sumas** con idempotencia y revisión del dueño, no un modo offline completo.
