# Contexto del proyecto (para una sesión nueva)

**Aiment Wallet**: plataforma de fidelización multi-negocio (puntos y sellos, tarjeta web, QR/NFC y, más adelante, Apple/Google Wallet). Fundador: Aiment Agency / Aiment Card (Perú).

## Estado al 17/10/2026

- Rama de trabajo: `claude/loyalty-platform-technical-review-0qpg4x`.
- **Semanas 1–5 cerradas oficialmente (09/10/2026)** tras la prueba en celulares físicos (iPhone 14 y Samsung A22 con Chrome 154): sin diferencias importantes frente a la emulación. Resultado en `docs/prueba-celulares.md`. Después de aprobar la 5 se agregó editar nombre/celular del cliente desde la ficha (#23).
- **Semana 6 aprobada (10/10/2026):** reportes, CSV, automatizaciones, PDF de mostrador, hardening, vencimientos programados, runbook y E2E del flujo crítico. Reporte: `docs/semana-6-reporte.md`.
- **Semana 7 por bloques (el fundador aprueba cada uno).** Bloque 1 (Google Wallet) **aprobado como integración simulada (17/10/2026)**; la real no está aprobada. **Pendiente obligatorio:** prueba en Android físico con credenciales reales (guardar, sumar y ver actualización, pausar/reactivar, escanear el QR desde Google Wallet), ver `docs/semana-7-bloque-1-reporte.md`. Bloque 2 (cambios de marca/programa/regla, mensajes y notificación en el pase) **aprobado como integración simulada (17/10/2026)**: `docs/semana-7-bloque-2-reporte.md`. La prueba real obligatoria suma: cambiar color/logo y verlo en el pase, y recibir la notificación al completar la meta.
- **PIN único por persona dentro de cada negocio** (ADR 0005, 17/10/2026): el PIN de excepción identifica a quién autorizó; un PIN compartido (datos viejos) no autoriza. PIN del seed: Jhon 2580, Mario 3691, dueño 1470, admin 5928.
- Google Wallet: `GOOGLE_WALLET_MODE=auto` → simulado hasta que estén el Issuer ID, `secrets/google-wallet-sa.json` y un `PUBLIC_BASE_URL` https. Botón solo en Android (decisión del fundador); en iPhone, Apple Wallet en la semana 8.
- Pruebas: 330 tests + 32 E2E (Android e iPhone emulados, con CSP estricta en CI). Último CI verde: run #26.

## Decisiones cerradas (no reabrir)

- Local-first, un solo dominio, titular persona individual, POS fuera del MVP, QR + NFC pasivo en el MVP.
- Tarjeta web obligatoria; Apple/Google Wallet después del núcleo (botones preparados y deshabilitados).
- **Supabase Auth** (ADR 0001); la API solo valida tokens (JWKS).
- Stack: Node + Hono + Drizzle + Postgres (Supabase), pg-boss, React + Vite PWA.
- Dos tokens por membresía (URL privada de la tarjeta, guardada **solo como hash** y rotada al recuperar — ADR 0002; `member_scan_token` del QR de caja).
- Límites de intentos: holgados por IP (IP compartida/CGNAT) + por celular/contacto y por dispositivo (ADR 0003).
- Caja: dispositivo autorizado por QR (cookie 180 días) + turno con PIN argon2id (12 h); en caja solo se opera, aunque entre el dueño.
- **La caja necesita internet; sin modo offline en el MVP** (ADR 0004). La PWA no tiene service worker.
- Editar datos del cliente: motivo obligatorio, auditoría sin PII (celular enmascarado), sin duplicados por negocio, no toca membresía ni tokens.
- Trabajador por sucursal (vacío = todas); quitar la sucursal corta el turno. Topes del plan: sucursales y trabajadores de caja activos.
- Negocio nuevo: lo crea el superadmin en `draft` (el dueño ya configura), Aiment lo publica (`live`). Cambiar de plantilla solo antes del primer cliente.
- Términos y privacidad: un checkbox, **pendiente de validación legal**; promociones siempre separado.
- Wallet: una cola por proveedor; `issuer_ref` por pase; un pase activo por membresía y proveedor (permite reemitir).
- **Alcance congelado:** no agregar funciones al MVP sin consultar al fundador.
- Al cerrar cada semana entregar: demo, resultados de pruebas, qué quedó terminado, bugs encontrados y corregidos, y deuda técnica.

## Dónde está cada cosa

| Documento                                               | Contenido                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------- |
| `docs/arquitectura-v1.1.md`                             | Arquitectura vigente                                          |
| `docs/backlog-mvp.md`                                   | Plan por semanas (1–5 cerradas, 6 terminada)                  |
| `docs/semana-1-reporte.md` … `docs/semana-6-reporte.md` | Reportes y **deuda técnica**                                  |
| `docs/runbook.md`                                       | Operación: variables, migraciones, respaldo y restauración    |
| `docs/decisiones/`                                      | ADR 0001 auth · 0002 token · 0003 límites · 0004 caja online  |
| `docs/prueba-celulares.md`                              | Checklist y resultado de la prueba en celulares reales        |
| `docs/guia-google-wallet-demo.md`                       | Prueba de Google Wallet (pendiente de la cuenta del fundador) |
| `README.md`                                             | Instalación y comandos                                        |

## Pendientes conocidos

- **Semana 7, bloque 1:** prueba real en Android cuando el fundador pase el Issuer ID, la cuenta de servicio y los correos de prueba (el dominio no hace falta: alcanza el túnel temporal).
- **Decididos por el fundador:** #12 shadcn/ui cerrada (no migrar si no hay mejora visible); #22 invitar admins → fase posterior, fuera del MVP; #23 editar cliente → hecha.
- **Semana 7, bloque 2:** aprobado en simulado (deuda #4 cerrada); falta verlo en la prueba real.
- **Fundador:**
  - si se consigue, repetir en un Android de gama baja real (C6, C13, P8): no se pudo en la prueba física;
  - **comprar el dominio** cuando haga falta para URLs públicas fijas (se le avisa; no bloquea el bloque 1);
  - prueba de Google Wallet en modo demo;
  - confirmar la dedicación de la desarrolladora;
  - revisión legal (casilla de consentimiento, textos).
- **Entorno de la nube:** el túnel HTTPS está bloqueado (403 a `trycloudflare.com`; se destraba permitiendo ese dominio en el acceso de red del entorno). Docker y Supabase local sí funcionan (si Docker no arranca: borrar `/var/run/docker.pid` y ejecutar `dockerd`). Para E2E aquí: `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome` (lo hace solo `pnpm demo`). Si el puerto 8787 está ocupado, puede ser una API vieja de otra sesión.
- **Mac del fundador:** Node 22 de Homebrew (`export PATH=/opt/homebrew/opt/node@22/bin:$PATH`; su Node global es 26). `pnpm e2e` necesita `pnpm dev` corriendo. Si Docker baja muy lento las imágenes de `public.ecr.aws`, bajarlas de Docker Hub (`supabase/…`) y etiquetarlas con el nombre de ECR. En la base local la Barbería quedó en plan Multi con una segunda sucursal (`pnpm db:reset` la devuelve al seed).
