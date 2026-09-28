# Aiment Wallet: reporte de la semana 3

Fecha: 28/09/2026 · Alcance congelado: flujo completo del cliente. QR/NFC del negocio → landing → registro → membresía → tarjeta web → QR individual, más la recuperación de tarjeta. Los botones de Apple y Google Wallet quedaron en la interfaz, deshabilitados. No se agregaron funciones fuera del MVP.

## 1. Demo

```bash
pnpm local:setup     # la primera vez
pnpm demo            # semana 3: flujo completo en Android e iPhone emulados (8/8)
pnpm local:tunnel    # para probar tú en celulares reales (checklist: docs/prueba-celulares.md)
```

`pnpm demo` levanta la API y la PWA si no están corriendo y recorre en cada celular:

1. **QR del local** (`/go/BRB2K?c=q`) → landing de Barbería Pedro (marca, beneficio, formulario, términos) → registro → **tarjeta web**.
2. **La tarjeta** muestra marca del negocio, nombre, sellos, progreso (0 de 10), próximo premio, QR individual, código corto, botones de Wallet deshabilitados ("próximamente") y "Powered by Aiment Wallet".
3. **El QR se lee desde la pantalla, como lo haría una cámara**, y se verifica que apunta a `/s/…` y no contiene la URL privada. Otra persona lo abre en otro dispositivo y solo ve "Presenta este código en caja de Barbería Pedro". Se revisan el HTML y las respuestas de la API: no aparecen nombre, saldo ni URL privada.
4. **Volver a escanear** el QR del local → "Ya tienes una tarjeta" → abre la misma.
5. **Mismo celular en otro dispositivo** → mensaje de tarjeta existente, sin segunda membresía.
6. **Recuperación por correo** en un "celular nuevo": el correo llega (Mailpit), el enlace abre la misma tarjeta y un segundo uso dice "ya no es válido".
7. **Recuperación en el local**: el dueño entra al panel (login real de Supabase), busca al cliente y muestra un QR de un solo uso; el cliente lo escanea y abre su tarjeta.

Además, el panel mínimo muestra el **QR de la sucursal** (descarga en PNG) y la **URL para grabar el NFC**. Las demos de las semanas 1 (19/19) y 2 (23/23) siguen pasando.

**Capturas:** `e2e/artifacts/` (12 en total, Android e iPhone). Te envío algunas junto con este reporte.

## 2. Resultados de pruebas

| Suite                                  | Tests   | Qué cubre                                                                                                     |
| -------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| Unitarias                              | 41      | Motor (99 % de cobertura), permisos, celulares peruanos, límite de intentos, Wallet, JWT de Google            |
| Integración: flujo público (nuevo)     | 22      | `/go`, landing, registro, duplicados, concurrencia, validaciones, tarjeta, QR de caja, recuperación, panel QR |
| Integración: API (aislamiento y roles) | 22      | Ahora **17 rutas** de negocio en la suite de aislamiento                                                      |
| Integración: ledger                    | 37      | Sin cambios                                                                                                   |
| Integración: base de datos (RLS)       | 15      | Detectó y cubre la tabla nueva de recuperaciones                                                              |
| Integración: Wallet/worker             | 7       | Sin cambios                                                                                                   |
| **Subtotal**                           | **144** | Estable en 3 corridas seguidas                                                                                |
| **E2E en celulares emulados**          | **8**   | 4 escenarios × Android (Pixel 7) + iPhone (14)                                                                |

**Verificaciones que pediste:**

| Pedido                                                | Cómo se verificó                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Dos tokens separados                                  | Test: `member_scan_token ≠ web_card_token`. Con el token del QR no se abre la tarjeta (404) y con el de la tarjeta no se abre la página del QR (404)                                                                                                                                       |
| El QR no revela la URL privada, el nombre ni el saldo | E2E: se decodifica el QR **desde la captura de pantalla**. Otra persona lo abre y se revisan el HTML y todas las respuestas de la API. Integración: la respuesta de `/s/` tiene solo `organizationName` y `message`                                                                        |
| Recuperación sin depender solo del celular            | El celular **no abre** la tarjeta. Solo dispara un enlace al **correo registrado** (nunca al que se escribe en ese momento), o se recupera en el local con verificación en persona                                                                                                         |
| Sin membresías duplicadas                             | El mismo celular en otro formato no crea otra. **5 registros simultáneos** del mismo celular → 1 cliente y 1 membresía. La recuperación nunca crea nada                                                                                                                                    |
| Enlaces de recuperación seguros                       | Un solo uso, vencen (30 min por correo, 10 min en local), se guarda solo su hash, 5 aperturas simultáneas → solo 1 funciona, máximo 3 correos por hora por cliente, respuesta neutra (no revela quién es cliente) y el enlace usa la URL configurada aunque la petición traiga otro `Host` |

**CI:** se agregó un job de E2E en GitHub Actions (Postgres + Mailpit + API + PWA compilada + Playwright). Lo simulé en local con una base limpia: 6/6. Los 2 casos del panel se omiten en CI porque ahí no hay Supabase Auth; esos casos quedan cubiertos por las pruebas de integración.

## 3. Prueba en celulares reales

**No la pude hacer desde este entorno.** La política de red de la sesión bloquea el túnel HTTPS (`trycloudflare.com` → 403), así que ningún teléfono puede llegar a la app que corre aquí. Lo que sí quedó listo:

- `pnpm local:tunnel`: en tu computadora abre el túnel, levanta todo con la URL correcta y muestra en la terminal el QR para escanear con el celular. No lo pude ejecutar aquí por el mismo bloqueo.
- `docs/prueba-celulares.md`: checklist de 10 pasos (cámara, NFC, duplicados, recuperación, datos móviles) para iPhone y Android de gama media y baja.
- Emulación automática de Android e iPhone: 8/8. Usa el motor Chromium, no Safari real.

Si prefieres que la prueba la haga yo desde aquí, habría que permitir `trycloudflare.com` en la red del entorno, y aun así el túnel necesita salida por el puerto 7844.

## 4. Bugs encontrados y corregidos

| Bug                                                                                                                                                                             | Cómo se detectó                         | Corrección                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Detrás del proxy local, todos los celulares compartían la misma IP**: el límite de intentos habría bloqueado a todos los clientes a la vez en una prueba con varios teléfonos | E2E: 5 fallos por "Demasiados intentos" | El proxy reenvía la IP real (`X-Forwarded-For`). Los límites se configuran por entorno: en producción quedan en 5 registros, 5 pedidos de recuperación y 10 aperturas cada 10 min; en local, más altos |
| El panel cargaba el cliente de Supabase también en la tarjeta del cliente (> 500 kB)                                                                                            | Aviso del build                         | El panel se descarga solo al abrirlo: la tarjeta pesa 109 kB comprimida (panel aparte: 57 kB)                                                                                                          |
| Los textos legales de la plataforma no eran visibles dentro de la transacción del negocio (RLS)                                                                                 | Diseño del registro                     | Se leen en una transacción de sistema de solo lectura y se registran por versión                                                                                                                       |
| Tests que suponían conteos fijos de clientes (30) fallaban según el orden de ejecución                                                                                          | Fallo intermitente (2 de 4 corridas)    | Comparan contra el conteo real en la base                                                                                                                                                              |
| Un test usaba un correo con "ñ" (el validador lo rechaza) y el primer registro fallaba en silencio                                                                              | Test de duplicado                       | Correo sin tildes + verificación del primer registro. Ver deuda #9                                                                                                                                     |
| Un selector de la prueba E2E encontraba dos campos ("celular" aparece en la ayuda del correo)                                                                                   | E2E                                     | Coincidencia exacta de etiqueta                                                                                                                                                                        |
| Punto suelto al final del texto de consentimiento                                                                                                                               | Revisión de capturas                    | Corregido                                                                                                                                                                                              |

## 5. Deuda técnica pendiente

**Ya identificada (se mantiene):**

| #   | Tema                                                                                                            | Semana                  |
| --- | --------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 1   | PIN de caja y dispositivo autorizado (la recuperación en caja ya tiene permiso para trabajador, falta su login) | 4                       |
| 2   | Mensaje al anular una suma anterior a la que completó la meta                                                   | 4                       |
| 3   | Job de expiración programado                                                                                    | 6                       |
| 4   | Sincronización de cambios de regla con los pases (`program.updated`)                                            | 7                       |
| 5   | Prueba real de Google Wallet en Android                                                                         | Cuando tengas la cuenta |

**Nueva de esta semana:**

| #   | Tema                                                                                                     | Por qué se deja                                                                    | Semana                                  |
| --- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------- |
| 6   | **Prueba en celulares reales** (Safari de iPhone real, cámara, NFC)                                      | Bloqueo de red del entorno                                                         | Tú, con `pnpm local:tunnel`             |
| 7   | Límite de intentos en memoria (una sola instancia)                                                       | Suficiente para local y piloto; con varias instancias va a Postgres o al borde     | 9                                       |
| 8   | Turnstile (anti-bots) en el registro                                                                     | Previsto al publicar                                                               | 9                                       |
| 9   | El validador rechaza correos con tildes o ñ en la parte antes de la @                                    | Poco frecuente; se puede aceptar si el proveedor de correo lo soporta              | 5                                       |
| 10  | Un solo checkbox acepta términos **y** privacidad (se registran por separado en la base)                 | Revisar con el abogado si deben ser dos                                            | Antes del piloto                        |
| 11  | La URL de la tarjeta se guarda en claro en la base (los enlaces de recuperación sí se guardan como hash) | Guardarla como hash obliga a rotarla en cada recuperación. Es decisión de producto | 5 (junto con "rotar tarjeta" del panel) |
| 12  | Se usó Tailwind sin la librería de componentes shadcn/ui                                                 | No hacía falta para 6 pantallas; se evalúa con el panel completo                   | 5                                       |
| 13  | La página del QR de caja muestra el nombre del negocio                                                   | Por diseño (arquitectura 6.3). Si prefieres ocultarlo, es un cambio de una línea   | —                                       |
