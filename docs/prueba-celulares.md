# Prueba en celulares reales (semanas 3, 4 y 5 — antes de la semana 6)

Las pruebas automáticas emulan un Android (Pixel 7) y un iPhone (14) en Chromium. Esta lista es para confirmar lo mismo en **teléfonos reales**, con su cámara, su lector NFC y su navegador (Safari en iPhone, Chrome en Android).

## Preparación (en tu computadora)

```bash
pnpm local:setup        # una vez
pnpm local:tunnel       # abre un túnel HTTPS y muestra un QR en la terminal
```

- El túnel es temporal (URL `https://….trycloudflare.com`) y funciona mientras la terminal esté abierta.
- Si `pnpm dev` está corriendo, detenlo antes: el túnel levanta la API y la PWA por su cuenta.
- Los correos de recuperación llegan a Mailpit: <http://127.0.0.1:54324>.
- Credenciales del panel (datos de prueba): `dueno.barberia@aiment.test` / `aiment-demo-2026`. Panel maestro: `superadmin@aiment.test` (misma contraseña).
- PIN de caja de los trabajadores del seed (Jhon, Mario): `2580`. PIN del dueño (autoriza excepciones): `1470`.
- Necesitas **dos teléfonos**: uno hace de cliente y otro de caja (idealmente un Android de gama media como caja).

## Checklist

Anota por cada teléfono: marca, modelo, gama, sistema y navegador.

| #   | Paso                                                                                       | Resultado esperado                                                                                                                                                               | iPhone | Android medio | Android bajo |
| --- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------- | ------------ |
| 1   | Escanear con la **cámara** el QR que muestra la terminal                                   | Se abre la landing de Barbería Pedro con la marca                                                                                                                                |        |               |              |
| 2   | Registrarse (nombre, celular; correo opcional)                                             | Se abre la tarjeta con nombre, 0 de 10 sellos, próximo premio, QR y "Powered by Aiment Wallet"                                                                                   |        |               |              |
| 3   | Revisar que la tarjeta se lea bien en pantalla chica                                       | Nada cortado; botones grandes; el QR se ve nítido                                                                                                                                |        |               |              |
| 4   | Con **otro** celular, escanear el QR de la tarjeta                                         | Solo dice "Presenta este código en caja de Barbería Pedro". **No** muestra nombre ni saldo                                                                                       |        |               |              |
| 5   | Volver a escanear el QR del local desde el primer celular                                  | Aparece "Ya tienes una tarjeta… Abrir mi tarjeta"                                                                                                                                |        |               |              |
| 6   | Registrarse otra vez con el **mismo celular** (otro navegador)                             | Mensaje de tarjeta existente; **no** se crea otra                                                                                                                                |        |               |              |
| 7   | Recuperar por correo (en un navegador en modo incógnito)                                   | Llega el correo a Mailpit; el enlace abre la **misma** tarjeta (con URL nueva); un segundo uso dice "ya no es válido"; en el primer navegador la URL vieja dice "ya no funciona" |        |               |              |
| 8   | Panel → buscar al cliente → "QR de recuperación" → escanearlo con el celular del cliente   | Abre la misma tarjeta; el QR sirve una sola vez                                                                                                                                  |        |               |              |
| 9   | **NFC:** grabar `…/go/BRB2K?c=n` en un tag de prueba (sin bloquearlo) y acercar el celular | Se abre la landing (en Android el NFC debe estar activado)                                                                                                                       |        |               |              |
| 10  | Datos móviles (sin Wi-Fi)                                                                  | Todo carga en unos pocos segundos                                                                                                                                                |        |               |              |
| 11  | Cumpleaños: escribir solo números (p. ej. 07031991)                                        | Se ve `07/03/1991` y se registra sin error                                                                                                                                       |        |               |              |
| 12  | Botones de Apple/Google Wallet en la tarjeta                                               | Se ven desactivados con la etiqueta "Próximamente"                                                                                                                               |        |               |              |

## Caja (semana 4)

| #   | Paso                                                                                                 | Resultado esperado                                                           | iPhone | Android medio | Android bajo |
| --- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------ | ------------- | ------------ |
| C1  | En el celular de caja abrir `…/caja`                                                                 | "Este dispositivo todavía no está autorizado"                                |        |               |              |
| C2  | Panel del dueño → Cajas → nombre del dispositivo → **Generar QR**; escanearlo con el celular de caja | "Quedó autorizado"; aparece "¿Quién atiende?"                                |        |               |              |
| C3  | Escanear el **mismo** QR con otro teléfono                                                           | "Este QR de autorización ya no es válido"                                    |        |               |              |
| C4  | Elegir "Jhon (caja)" y escribir un PIN equivocado 5 veces                                            | Avisa los intentos restantes y al 5.º bloquea 15 minutos                     |        |               |              |
| C5  | Entrar con "Mario (caja)" y PIN `2580`                                                               | Pantalla con **ESCANEAR CLIENTE** grande                                     |        |               |              |
| C6  | **ESCANEAR CLIENTE** y apuntar a la tarjeta del teléfono cliente (probar con poca luz y brillo bajo) | Pide permiso de cámara la 1.ª vez; abre la ficha del cliente en menos de 3 s |        |               |              |
| C7  | **SUMAR VISITA**                                                                                     | "+1 sello"; al volver a la tarjeta del cliente se ve el sello                |        |               |              |
| C8  | Sumar otra vez                                                                                       | "Este cliente ya sumó hace poco" → motivo + PIN del dueño `1470` → se suma   |        |               |              |
| C9  | **Anular** el último movimiento (elegir un motivo)                                                   | "Anulado"; el saldo vuelve atrás                                             |        |               |              |
| C10 | Buscar al cliente por celular y por el código de 6 letras de su tarjeta                              | Abre la misma ficha                                                          |        |               |              |
| C11 | "El cliente perdió su tarjeta: QR de recuperación" y escanearlo con un tercer navegador del cliente  | Abre la tarjeta; en el celular anterior la URL vieja dice "ya no funciona"   |        |               |              |
| C12 | Panel → Cajas → **Revocar** el dispositivo                                                           | La caja vuelve a "no está autorizado" en la siguiente acción                 |        |               |              |
| C13 | Medir con un cronómetro: escanear → sumar → confirmación                                             | Menos de 5 s por operación                                                   |        |               |              |
| C14 | Usar la caja con una sola mano (pulgar)                                                              | Todos los botones se alcanzan y se presionan sin errores                     |        |               |              |
| C15 | Con la caja abierta, activar el **modo avión**                                                       | Franja roja "Sin conexión a internet"; al volver la señal desaparece         |        |               |              |

## Panel del dueño (semana 5)

Hazlo desde el **celular del dueño** (es donde lo usará). Si puedes, crea el negocio desde cero: en la computadora abre `…/admin`, crea un negocio con **tu correo** y abre la invitación que llega a Mailpit desde el celular.

| #   | Paso                                                                                          | Resultado esperado                                                                                    | iPhone | Android medio | Android bajo |
| --- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------ | ------------- | ------------ |
| P1  | Abrir el enlace de la invitación y crear la contraseña                                        | Entra al panel; el enlace no sirve dos veces                                                          |        |               |              |
| P2  | Marca → **Subir logo** → elegir una **foto de la galería** (y otra vez con la **cámara**)     | Sube en pocos segundos; el logo se ve en la vista previa. En iPhone, las fotos HEIC también funcionan |        |               |              |
| P3  | Elegir un color claro (amarillo pastel)                                                       | Avisa que los sellos se verán poco y ofrece un tono más oscuro                                        |        |               |              |
| P4  | Escribir frase, condiciones y contacto → Guardar                                              | La vista previa y la tarjeta real del cliente muestran lo mismo                                       |        |               |              |
| P5  | Programa → cambiar la meta y el premio → Guardar                                              | "Regla guardada"; la tarjeta del cliente muestra la meta nueva                                        |        |               |              |
| P6  | Sucursales → completar dirección → **Descargar QR** e imprimirlo o mostrarlo en otra pantalla | El PNG se descarga; escaneado abre el registro del negocio                                            |        |               |              |
| P7  | Equipo → agregar trabajador con PIN; si hay 2 sucursales, "Solo en…" una                      | Aparece en la caja de esa sucursal y **no** en la de la otra                                          |        |               |              |
| P8  | Cajas → Generar QR → escanearlo con el celular de caja                                        | Queda autorizada en esa sucursal                                                                      |        |               |              |
| P9  | Clientes → buscar por nombre y por celular → abrir la ficha                                   | Saldo, historial con quién atendió                                                                    |        |               |              |
| P10 | Bloquear al cliente → revisar su tarjeta y la caja → Desbloquear                              | Tarjeta "pausada" sin QR; la caja no suma; al desbloquear todo vuelve                                 |        |               |              |
| P11 | Navegar el panel con una mano; girar el celular                                               | Menú de secciones se desliza; nada cortado; botones fáciles de tocar                                  |        |               |              |
| P12 | Ficha del cliente → **Editar datos** → cambiar nombre y celular, escribir el motivo → Guardar | "Datos actualizados"; la tarjeta del cliente (misma URL) muestra el nombre nuevo y el mismo saldo     |        |               |              |
| P13 | Editar otra vez y poner el celular de **otro** cliente                                        | "Ese celular ya lo usa otro cliente"; no se guarda nada                                               |        |               |              |

## Modo sin conexión (todos los teléfonos)

La caja **necesita internet** (ADR 0004): no hay modo offline en el MVP. Lo que se prueba es que, sin señal, el sistema **avise claro y no duplique nada** al volver.

| #   | Paso                                                                                              | Resultado esperado                                                                                                                            | iPhone | Android medio | Android bajo |
| --- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------- | ------------ |
| O1  | Caja con un cliente abierto → modo avión → **SUMAR VISITA**                                       | Franja roja "Sin conexión"; mensaje de error claro; **no** dice "+1 sello"                                                                    |        |               |              |
| O2  | Quitar el modo avión → volver a buscar al cliente                                                 | El saldo no cambió por el intento fallido; se puede sumar normalmente                                                                         |        |               |              |
| O3  | Con señal muy débil (ascensor, sótano o "3G" en opciones de desarrollador) → SUMAR VISITA una vez | Suma **una sola vez** aunque tarde; si sale error, tocar **"Reintentar (no se duplica)"**: el historial muestra 1 visita                      |        |               |              |
| O4  | Cliente: abrir su tarjeta con señal, luego modo avión y recargar                                  | Aparece el aviso de sin conexión del navegador (en el MVP la tarjeta no se guarda en el teléfono); al volver la señal, recargar la abre igual |        |               |              |
| O5  | Panel: guardar un cambio en modo avión                                                            | Error claro "sin conexión"; al volver la señal se guarda al reintentar                                                                        |        |               |              |

Si algo de esta tabla o de las anteriores se comporta distinto que en la emulación (pantalla en blanco, cámara que no abre, doble suma, botones cortados), anótalo con captura y modelo: se corrige **antes** de empezar la semana 6.

**Importante:** la cámara del navegador solo funciona por `https://` (el túnel) o en `localhost`. Si abres la caja por la IP de la laptop en el Wi-Fi (`http://192.168…`), la cámara no abrirá: usa el túnel o la búsqueda por celular.

## Qué NO hacer en esta prueba

- No grabar tags con la URL del túnel **bloqueados**: la URL cambia cada vez. Los tags definitivos se graban con el dominio final (semana 9).
- No usar datos reales de clientes: todo es de prueba.
