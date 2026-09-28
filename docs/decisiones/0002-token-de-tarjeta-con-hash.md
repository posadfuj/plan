# ADR 0002: URL de la tarjeta guardada como hash y rotada al recuperar

- **Estado:** aceptada (semana 4, a pedido del fundador)
- **Contexto:** hasta la semana 3, `memberships.web_card_token` (la URL privada `/m/…` de la tarjeta) se guardaba en claro. Los enlaces de recuperación ya se guardaban como hash. El fundador pidió evaluar guardar también el token de la tarjeta como hash y rotarlo al recuperar (deuda #11).

## Opciones

|                                                    | Token en claro (antes)                              | Hash + rotación al recuperar (ahora)                                             |
| -------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------- |
| Si se filtra un respaldo o una consulta de la base | Quien lo tenga puede abrir **todas** las tarjetas   | No sirve: con el hash no se arma la URL                                          |
| Celular perdido o robado                           | La URL vieja sigue abriendo la tarjeta para siempre | Al recuperar la tarjeta, la URL vieja deja de funcionar                          |
| Reenviar la **misma** URL al recuperar             | Posible                                             | No: siempre se entrega una URL nueva                                             |
| Cliente con la tarjeta abierta en dos celulares    | Ambos siguen funcionando                            | Al recuperar en uno, el otro muestra "Este enlace ya no funciona" y cómo pedirla |
| Costo                                              | —                                                   | Un SHA-256 por lectura (despreciable)                                            |

## Decisión

**Hash + rotación.** El token es de 128 bits aleatorios, así que un SHA-256 sin sal es suficiente (no hay nada que adivinar por diccionario, a diferencia de un PIN). Se aplica igual en los dos caminos de recuperación (correo y QR en caja).

## Cómo se implementó

- Columna renombrada a `memberships.web_card_token_hash` (migración `0005`). La migración convierte los tokens existentes a su hash en la misma operación: **las tarjetas ya entregadas siguen funcionando**.
- Registro: se genera el token, se guarda su hash y el token en claro solo se devuelve al celular del cliente.
- Tarjeta (`GET /v1/public/cards/:token`): se busca por `hash(token)`.
- Recuperación (`redeemRecovery`): marca el enlace como usado, genera un token nuevo, reemplaza el hash y lo audita (`card.recovered`, `cardTokenRotated: true`).
- La PWA, al recibir 404 con un enlace guardado, lo olvida y explica que la tarjeta pudo recuperarse en otro celular.
- Los QR impresos, los pases de Wallet y el QR de caja (`member_scan_token`) **no** cambian: son otro token, sin datos personales.

## Pendiente

- Botón "rotar tarjeta" en el panel del dueño (semana 5): reutiliza la misma rotación.
