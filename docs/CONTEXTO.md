# Contexto del proyecto (para una sesión nueva)

**Aiment Wallet**: plataforma de fidelización multi-negocio (puntos y sellos, tarjeta web, QR/NFC y, más adelante, Apple/Google Wallet). Fundador: Aiment Agency / Aiment Card (Perú).

## Estado al 28/09/2026

- Rama de trabajo: `claude/loyalty-platform-technical-review-0qpg4x`.
- **Semanas 1, 2 y 3 aprobadas** por el fundador. Próxima: **semana 4 (modo trabajador / caja con PIN)**.
- CI verde: lint, tipos, migraciones, 144 tests, E2E y gitleaks.

## Decisiones cerradas (no reabrir)

- Local-first, un solo dominio, titular persona individual, POS fuera del MVP, QR + NFC pasivo en el MVP.
- Tarjeta web obligatoria; Apple/Google Wallet después del núcleo (botones preparados y deshabilitados).
- **Supabase Auth** (ADR 0001); la API solo valida tokens (JWKS).
- Stack: Node + Hono + Drizzle + Postgres (Supabase), pg-boss, React + Vite PWA.
- Dos tokens por membresía (`web_card_token` privado, `member_scan_token` del QR de caja).
- Wallet: una cola por proveedor; `issuer_ref` por pase; un pase activo por membresía y proveedor (permite reemitir).
- **Alcance congelado:** no agregar funciones al MVP sin consultar al fundador.
- Al cerrar cada semana entregar: demo, resultados de pruebas, qué quedó terminado, bugs encontrados y corregidos, y deuda técnica.

## Dónde está cada cosa

| Documento                                               | Contenido                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------- |
| `docs/arquitectura-v1.1.md`                             | Arquitectura vigente                                          |
| `docs/backlog-mvp.md`                                   | Plan por semanas (1–3 marcadas como hechas)                   |
| `docs/semana-1-reporte.md` … `docs/semana-3-reporte.md` | Reportes y **deuda técnica**                                  |
| `docs/decisiones/0001-autenticacion.md`                 | Decisión de autenticación                                     |
| `docs/prueba-celulares.md`                              | Checklist para celulares reales (pendiente del fundador)      |
| `docs/guia-google-wallet-demo.md`                       | Prueba de Google Wallet (pendiente de la cuenta del fundador) |
| `README.md`                                             | Instalación y comandos                                        |

## Pendientes conocidos

- **Semana 4:** PIN de caja + dispositivo autorizado, pantalla de escaneo, mejorar el mensaje de anulación.
- **Semana 6:** job de expiración programado.
- **Semana 7:** sincronizar los cambios de regla con los pases.
- **Fundador:**
  - prueba en celulares reales (`pnpm local:tunnel`);
  - prueba de Google Wallet en modo demo;
  - confirmar la dedicación de la desarrolladora;
  - revisión legal (casilla de consentimiento, textos).
- **Entorno de la nube:** el túnel HTTPS está bloqueado (403 a `trycloudflare.com`). Docker y Supabase local sí funcionan (si Docker no arranca: borrar `/var/run/docker.pid` y ejecutar `dockerd`).
