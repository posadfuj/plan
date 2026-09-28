# Aiment Wallet

Plataforma de fidelización digital multi-negocio: puntos y sellos, tarjeta web, QR/NFC y Apple/Google Wallet.

> Estado: **semana 4 del MVP (local-first)**. Reportes: [semana 1](docs/semana-1-reporte.md) · [semana 2](docs/semana-2-reporte.md) · [semana 3](docs/semana-3-reporte.md) · [semana 4](docs/semana-4-reporte.md).
> Documentos: [arquitectura v1.1](docs/arquitectura-v1.1.md) · [backlog](docs/backlog-mvp.md) · [decisiones](docs/decisiones/).

## Requisitos

- Node.js **22.12+** (`.nvmrc`)
- Para `pnpm demo` / `pnpm e2e`: `pnpm exec playwright install chromium` (una vez)
- pnpm **10** (`corepack enable`)
- Docker (para Supabase local)

## Instalación desde cero

```bash
pnpm install
pnpm local:setup   # levanta Supabase local, genera .env, migra y carga datos de prueba
pnpm demo          # semana 4: caja + flujo del cliente en Android e iPhone emulados (14/14)
                   # anteriores: pnpm demo:semana-3 (8) · pnpm demo:semana-2 (23) · pnpm demo:semana-1 (19)
```

`pnpm local:setup` equivale a:

```bash
pnpm local:up      # Supabase CLI en Docker: Postgres 17 + Auth + Mailpit
pnpm local:env     # genera .env desde `supabase status` (no se sube al repositorio)
pnpm db:reset      # borra la base local, aplica migraciones, crea el rol de la API y carga el seed
```

## Uso diario

| Comando                   | Qué hace                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------- |
| `pnpm dev`                | API (http://localhost:8787) + worker con Wallet simulado                              |
| `pnpm test`               | Tests unitarios + integración (crea una base aparte, `aiment_test`)                   |
| `pnpm check`              | Formato, lint, tipos y tests (lo mismo que CI)                                        |
| `pnpm db:reset`           | Vuelve la base local al estado inicial de prueba                                      |
| `pnpm db:generate`        | Genera una migración a partir de `packages/db/src/schema.ts`                          |
| `pnpm db:check`           | Verifica que esquema y migraciones estén sincronizados                                |
| `pnpm wallet:google-demo` | Enlace de prueba "Guardar en Google Wallet" ([guía](docs/guia-google-wallet-demo.md)) |
| `pnpm local:down`         | Detiene Supabase local                                                                |

Mailpit (correos locales): http://127.0.0.1:54324

## Datos de prueba

Todos son ficticios. Contraseña de todos los usuarios: `aiment-demo-2026` (variable `SEED_USER_PASSWORD`).
PIN de caja de los trabajadores: `2580`. PIN de dueños y admin (autoriza excepciones en caja): `1470`.

| Usuario                      | Rol                                                      |
| ---------------------------- | -------------------------------------------------------- |
| `superadmin@aiment.test`     | Superadmin (panel maestro)                               |
| `dueno.barberia@aiment.test` | Dueño · Barbería Pedro (sellos, 10 = corte gratis)       |
| `admin.barberia@aiment.test` | Admin · Barbería Pedro                                   |
| `dueno.cafe@aiment.test`     | Dueña · Café Aroma (puntos, S/1 = 1 punto)               |
| `dueno.vet@aiment.test`      | Dueño · Veterinaria Patitas (sellos, 6 = baño gratis)    |
| Jhon, Mario (caja)           | Trabajadores de la barbería (sin correo: entran con PIN) |

El celular `+51987000001` está registrado en la barbería y en la veterinaria como dos clientes independientes.

## Estructura

```
apps/api        API Hono: autenticación (Supabase Auth), roles, endpoints, rutas públicas
apps/web        PWA: registro, tarjeta web, QR de caja, recuperación, caja (/caja), panel mínimo
apps/worker     outbox → pg-boss (una cola por proveedor) → sincronización de Wallet
packages/core   reglas puras: matriz de permisos y motor de puntos/sellos
packages/ledger servicio transaccional: sumar, canjear, ajustar, anular, reglas y premios
packages/enrollment registro, tarjeta web, QR de caja y recuperación
packages/staff  caja: dispositivos autorizados, turnos con PIN, equipo y ficha del cliente
packages/mail   correo (Mailpit en local, memoria en tests)
packages/db     esquema Drizzle, migraciones, RLS, seed
packages/wallet interfaz WalletProvider, Wallet simulado, enlace Google Wallet
packages/config variables de entorno
supabase/       configuración de Supabase local
docs/           arquitectura, backlog, decisiones y reportes
```

## Reglas de seguridad del repositorio

- `.env`, `secrets/`, `*.p12`, `*.pem` y los JSON de cuentas de servicio **nunca** se suben (CI escanea con gitleaks).
- La API se conecta con el usuario `aiment_api` (rol `app_api`, sin `BYPASSRLS`). El usuario administrador solo se usa para migraciones y seed.
- Todo endpoint nuevo bajo `/v1/orgs/:orgId` debe agregarse a la suite de aislamiento (`apps/api/src/api.int.test.ts`); un test falla si falta.
- El ledger no se edita ni se borra: correcciones = reversa o ajuste.
- Toda operación que cambia saldo exige la cabecera `Idempotency-Key` (una por intención, no por clic).
- Las rutas de caja (`/v1/staff/*`) toman el negocio del dispositivo, nunca de la URL; toda ruta nueva va en `apps/api/src/staff.int.test.ts` (un test falla si falta).
- Tokens, secretos y PIN se guardan solo como hash (SHA-256 para tokens de 128 bits, argon2id para PIN).
