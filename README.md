# Aiment Wallet

Plataforma de fidelización digital multi-negocio: puntos y sellos, tarjeta web, QR/NFC y Apple/Google Wallet.

> Estado: **semana 1 del MVP (local-first)**. Ver [`docs/semana-1-reporte.md`](docs/semana-1-reporte.md).
> Documentos: [arquitectura v1.1](docs/arquitectura-v1.1.md) · [backlog](docs/backlog-mvp.md) · [decisiones](docs/decisiones/).

## Requisitos

- Node.js **22.12+** (`.nvmrc`)
- pnpm **10** (`corepack enable`)
- Docker (para Supabase local)

## Instalación desde cero

```bash
pnpm install
pnpm local:setup   # levanta Supabase local, genera .env, migra y carga datos de prueba
pnpm demo          # recorrido guiado de la semana 1 (19 verificaciones)
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

| Usuario                      | Rol                                                   |
| ---------------------------- | ----------------------------------------------------- |
| `superadmin@aiment.test`     | Superadmin (panel maestro)                            |
| `dueno.barberia@aiment.test` | Dueño · Barbería Pedro (sellos, 10 = corte gratis)    |
| `admin.barberia@aiment.test` | Admin · Barbería Pedro                                |
| `dueno.cafe@aiment.test`     | Dueña · Café Aroma (puntos, S/1 = 1 punto)            |
| `dueno.vet@aiment.test`      | Dueño · Veterinaria Patitas (sellos, 6 = baño gratis) |

El celular `+51987000001` está registrado en la barbería y en la veterinaria como dos clientes independientes.

## Estructura

```
apps/api        API Hono: autenticación (Supabase Auth), roles, endpoints
apps/worker     outbox → pg-boss → sincronización de Wallet
packages/core   reglas puras (hoy: matriz de permisos; semana 2: motor de puntos/sellos)
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
