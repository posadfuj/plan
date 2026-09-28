# Contexto del proyecto (para una sesión nueva)

**Aiment Wallet**: plataforma de fidelización multi-negocio (puntos y sellos, tarjeta web, QR/NFC y, más adelante, Apple/Google Wallet). Fundador: Aiment Agency / Aiment Card (Perú).

## Estado al 28/09/2026

- Rama de trabajo: `claude/loyalty-platform-technical-review-0qpg4x`.
- **Semanas 1, 2, 3 y 4 aprobadas** por el fundador. Próxima: **semana 5 (panel del dueño y superadmin)**. Antes o al inicio, el fundador hará la prueba en celulares físicos (cliente y caja).
- Pruebas: 182 tests + 14 E2E (Android e iPhone emulados). CI verde (run #10).

## Decisiones cerradas (no reabrir)

- Local-first, un solo dominio, titular persona individual, POS fuera del MVP, QR + NFC pasivo en el MVP.
- Tarjeta web obligatoria; Apple/Google Wallet después del núcleo (botones preparados y deshabilitados).
- **Supabase Auth** (ADR 0001); la API solo valida tokens (JWKS).
- Stack: Node + Hono + Drizzle + Postgres (Supabase), pg-boss, React + Vite PWA.
- Dos tokens por membresía (URL privada de la tarjeta, guardada **solo como hash** y rotada al recuperar — ADR 0002; `member_scan_token` del QR de caja).
- Límites de intentos: holgados por IP (IP compartida/CGNAT) + por celular/contacto y por dispositivo (ADR 0003).
- Caja: dispositivo autorizado por QR (cookie 180 días) + turno con PIN argon2id (12 h); en caja solo se opera, aunque entre el dueño.
- Términos y privacidad: un checkbox, **pendiente de validación legal**; promociones siempre separado.
- Wallet: una cola por proveedor; `issuer_ref` por pase; un pase activo por membresía y proveedor (permite reemitir).
- **Alcance congelado:** no agregar funciones al MVP sin consultar al fundador.
- Al cerrar cada semana entregar: demo, resultados de pruebas, qué quedó terminado, bugs encontrados y corregidos, y deuda técnica.

## Dónde está cada cosa

| Documento                                               | Contenido                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------- |
| `docs/arquitectura-v1.1.md`                             | Arquitectura vigente                                          |
| `docs/backlog-mvp.md`                                   | Plan por semanas (1–4 marcadas como hechas)                   |
| `docs/semana-1-reporte.md` … `docs/semana-4-reporte.md` | Reportes y **deuda técnica**                                  |
| `docs/decisiones/`                                      | ADR 0001 autenticación · 0002 token de tarjeta · 0003 límites |
| `docs/prueba-celulares.md`                              | Checklist para celulares reales (pendiente del fundador)      |
| `docs/guia-google-wallet-demo.md`                       | Prueba de Google Wallet (pendiente de la cuenta del fundador) |
| `README.md`                                             | Instalación y comandos                                        |

## Pendientes conocidos

- **Semana 5:** panel completo (marca, programa, clientes, trabajadores y dispositivos), superadmin.
- **Semana 6:** job de expiración programado.
- **Semana 7:** sincronizar los cambios de regla con los pases.
- **Fundador:**
  - prueba en celulares reales, cliente **y caja** (`pnpm local:tunnel` + `docs/prueba-celulares.md`);
  - prueba de Google Wallet en modo demo;
  - confirmar la dedicación de la desarrolladora;
  - revisión legal (casilla de consentimiento, textos).
- **Entorno de la nube:** el túnel HTTPS está bloqueado (403 a `trycloudflare.com`). Docker y Supabase local sí funcionan (si Docker no arranca: borrar `/var/run/docker.pid` y ejecutar `dockerd`). Para E2E aquí: `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome` (lo hace solo `pnpm demo`). Si el puerto 8787 está ocupado, puede ser una API vieja de otra sesión.
