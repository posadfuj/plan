# Contexto del proyecto (para una sesión nueva)

**Aiment Wallet**: plataforma de fidelización multi-negocio (puntos y sellos, tarjeta web, QR/NFC y, más adelante, Apple/Google Wallet). Fundador: Aiment Agency / Aiment Card (Perú).

## Estado al 28/09/2026

- Rama de trabajo: `claude/loyalty-platform-technical-review-0qpg4x`.
- **Semanas 1–4 aprobadas**; **semana 5 (panel del dueño y superadmin) entregada, pendiente de aprobación**. Próxima: semana 6 (reportes, automatizaciones y hardening).
- **Antes de la semana 6:** prueba en celulares físicos (cliente, caja y panel). Si aparece una diferencia importante con la emulación, se corrige primero (pedido del fundador).
- Pruebas: 226 tests + 20 E2E (Android e iPhone emulados; los del panel también corren en CI). CI verde (run #15).

## Decisiones cerradas (no reabrir)

- Local-first, un solo dominio, titular persona individual, POS fuera del MVP, QR + NFC pasivo en el MVP.
- Tarjeta web obligatoria; Apple/Google Wallet después del núcleo (botones preparados y deshabilitados).
- **Supabase Auth** (ADR 0001); la API solo valida tokens (JWKS).
- Stack: Node + Hono + Drizzle + Postgres (Supabase), pg-boss, React + Vite PWA.
- Dos tokens por membresía (URL privada de la tarjeta, guardada **solo como hash** y rotada al recuperar — ADR 0002; `member_scan_token` del QR de caja).
- Límites de intentos: holgados por IP (IP compartida/CGNAT) + por celular/contacto y por dispositivo (ADR 0003).
- Caja: dispositivo autorizado por QR (cookie 180 días) + turno con PIN argon2id (12 h); en caja solo se opera, aunque entre el dueño.
- **La caja necesita internet; sin modo offline en el MVP** (ADR 0004).
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
| `docs/backlog-mvp.md`                                   | Plan por semanas (1–5 marcadas como hechas)                   |
| `docs/semana-1-reporte.md` … `docs/semana-5-reporte.md` | Reportes y **deuda técnica**                                  |
| `docs/decisiones/`                                      | ADR 0001 auth · 0002 token · 0003 límites · 0004 caja online  |
| `docs/prueba-celulares.md`                              | Checklist para celulares reales (pendiente del fundador)      |
| `docs/guia-google-wallet-demo.md`                       | Prueba de Google Wallet (pendiente de la cuenta del fundador) |
| `README.md`                                             | Instalación y comandos                                        |

## Pendientes conocidos

- **Semana 6:** reportes, CSV, automatizaciones, hardening y job de expiración programado.
- **Decisiones pedidas al fundador (semana 5):** cerrar la deuda #12 (shadcn/ui); invitar admins (#22) y editar datos del cliente (#23) desde el panel, que no están en el MVP.
- **Semana 7:** sincronizar los cambios de regla con los pases.
- **Fundador:**
  - prueba en celulares reales: cliente, caja **y panel** (`pnpm local:tunnel` + `docs/prueba-celulares.md`);
  - prueba de Google Wallet en modo demo;
  - confirmar la dedicación de la desarrolladora;
  - revisión legal (casilla de consentimiento, textos).
- **Entorno de la nube:** el túnel HTTPS está bloqueado (403 a `trycloudflare.com`; se destraba permitiendo ese dominio en el acceso de red del entorno). Docker y Supabase local sí funcionan (si Docker no arranca: borrar `/var/run/docker.pid` y ejecutar `dockerd`). Para E2E aquí: `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome` (lo hace solo `pnpm demo`). Si el puerto 8787 está ocupado, puede ser una API vieja de otra sesión.
