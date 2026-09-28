# Guía: prueba de Google Wallet en modo demo (semana 1)

Objetivo: comprobar con celulares Android reales en Perú que un pase de fidelización de prueba se guarda en Google Wallet. Costo: US$0. Tiempo aproximado: 30–45 minutos.

> Los nombres de menús de las consolas de Google cambian con frecuencia. Si algo no coincide, busca la opción equivalente. **[verificar en la consola]**

## 1. Proyecto de Google Cloud y cuenta de servicio

1. Entra a <https://console.cloud.google.com> con la cuenta de Google que será dueña de Aiment Wallet.
2. Crea un proyecto, por ejemplo `aiment-wallet`.
3. Busca **Google Wallet API** y actívala.
4. Ve a **IAM y administración → Cuentas de servicio → Crear cuenta de servicio** (por ejemplo `wallet-issuer`). No necesita roles de proyecto.
5. Entra a la cuenta creada → **Claves → Agregar clave → JSON**. Se descarga un archivo.
6. Guarda ese archivo en el repositorio local como `secrets/google-wallet-sa.json`. La carpeta `secrets/` está en `.gitignore` y **nunca** se sube.

## 2. Cuenta emisora (issuer) en modo demo

1. Entra a <https://pay.google.com/business/console> y crea el perfil de negocio (como persona individual).
2. Abre **Google Wallet API** y crea la cuenta emisora. Anota el **Issuer ID** (un número largo).
3. En **Usuarios**, invita el correo de la cuenta de servicio (`...@...iam.gserviceaccount.com`) con acceso de desarrollador.
4. En modo demo, solo las cuentas de Google que agregues como usuarios o cuentas de prueba del emisor pueden guardar los pases. Agrega las cuentas de los 3–4 teléfonos Android de la prueba.
5. **No** solicites todavía el acceso de publicación: eso va en la semana 8, con el flujo real funcionando.

## 3. Generar el enlace

En `.env`:

```bash
GOOGLE_WALLET_ISSUER_ID=3388000000012345678       # tu Issuer ID
GOOGLE_WALLET_SA_JSON_PATH=./secrets/google-wallet-sa.json
GOOGLE_DEMO_LOGO_URL=https://.../logo.png          # imagen pública https (PNG/JPG cuadrada)
```

Después ejecuta:

```bash
pnpm wallet:google-demo
```

El script imprime un enlace `https://pay.google.com/gp/v/save/...` con un pase de la "Barbería Pedro (demo)": 7 de 10 sellos, con QR.

## 4. Prueba en campo

Abre el enlace en cada Android (se puede enviar por WhatsApp) con una cuenta de prueba y anota:

| Teléfono (marca, modelo, gama) | Android | ¿Tiene Google Wallet? | ¿Se guardó el pase? | Observaciones |
| ------------------------------ | ------- | --------------------- | ------------------- | ------------- |
|                                |         |                       |                     |               |

Qué observar:

- que el pase aparece en Google Wallet con el logo, el nombre y los sellos;
- que el QR del pase se ve bien;
- en equipos de gama baja: si Google Wallet está instalado o si hay que descargarlo de Play Store.

Comparte la tabla completa; con ella decidimos cómo presentar el botón de Wallet en la tarjeta web.
