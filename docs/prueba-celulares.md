# Prueba en celulares reales (semana 3)

Las pruebas automáticas emulan un Android (Pixel 7) y un iPhone (14) en Chromium. Esta lista es para confirmar lo mismo en **teléfonos reales**, con su cámara, su lector NFC y su navegador (Safari en iPhone, Chrome en Android).

## Preparación (en tu computadora)

```bash
pnpm local:setup        # una vez
pnpm local:tunnel       # abre un túnel HTTPS y muestra un QR en la terminal
```

- El túnel es temporal (URL `https://….trycloudflare.com`) y funciona mientras la terminal esté abierta.
- Si `pnpm dev` está corriendo, detenlo antes: el túnel levanta la API y la PWA por su cuenta.
- Los correos de recuperación llegan a Mailpit: <http://127.0.0.1:54324>.
- Credenciales del panel (datos de prueba): `dueno.barberia@aiment.test` / `aiment-demo-2026`.

## Checklist

Anota por cada teléfono: marca, modelo, gama, sistema y navegador.

| #   | Paso                                                                                       | Resultado esperado                                                                                    | iPhone | Android medio | Android bajo |
| --- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------ | ------------- | ------------ |
| 1   | Escanear con la **cámara** el QR que muestra la terminal                                   | Se abre la landing de Barbería Pedro con la marca                                                     |        |               |              |
| 2   | Registrarse (nombre, celular; correo opcional)                                             | Se abre la tarjeta con nombre, 0 de 10 sellos, próximo premio, QR y "Powered by Aiment Wallet"        |        |               |              |
| 3   | Revisar que la tarjeta se lea bien en pantalla chica                                       | Nada cortado; botones grandes; el QR se ve nítido                                                     |        |               |              |
| 4   | Con **otro** celular, escanear el QR de la tarjeta                                         | Solo dice "Presenta este código en caja de Barbería Pedro". **No** muestra nombre ni saldo            |        |               |              |
| 5   | Volver a escanear el QR del local desde el primer celular                                  | Aparece "Ya tienes una tarjeta… Abrir mi tarjeta"                                                     |        |               |              |
| 6   | Registrarse otra vez con el **mismo celular** (otro navegador)                             | Mensaje de tarjeta existente; **no** se crea otra                                                     |        |               |              |
| 7   | Recuperar por correo (en un navegador en modo incógnito)                                   | Llega el correo a Mailpit; el enlace abre la **misma** tarjeta; un segundo uso dice "ya no es válido" |        |               |              |
| 8   | Panel → buscar al cliente → "QR de recuperación" → escanearlo con el celular del cliente   | Abre la misma tarjeta; el QR sirve una sola vez                                                       |        |               |              |
| 9   | **NFC:** grabar `…/go/BRB2K?c=n` en un tag de prueba (sin bloquearlo) y acercar el celular | Se abre la landing (en Android el NFC debe estar activado)                                            |        |               |              |
| 10  | Datos móviles (sin Wi-Fi)                                                                  | Todo carga en unos pocos segundos                                                                     |        |               |              |

## Qué NO hacer en esta prueba

- No grabar tags con la URL del túnel **bloqueados**: la URL cambia cada vez. Los tags definitivos se graban con el dominio final (semana 9).
- No usar datos reales de clientes: todo es de prueba.
