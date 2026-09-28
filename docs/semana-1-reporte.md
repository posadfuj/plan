# Aiment Wallet: reporte de la semana 1

Fecha: 28/09/2026 · Alcance: el aprobado en la arquitectura v1.1, sin funciones nuevas.

## Resumen

La base técnica está terminada y verificada. Todo corre en local con 3 comandos. El aislamiento entre negocios está probado en la base de datos y en la API, con logins reales de Supabase Auth. El Wallet simulado ya recibe eventos y reintenta si falla. Queda pendiente, por depender de tus cuentas, la prueba de Google Wallet con un Android real; el generador del enlace está listo.

| Indicador                                                     | Resultado                                                                                                                                             |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Demo (`pnpm demo`)                                            | **19/19** verificaciones correctas                                                                                                                    |
| Tests automáticos                                             | **46** (8 unitarios + 38 de integración), estables en 4 ejecuciones seguidas                                                                          |
| Simulación de CI (Postgres 17 limpio, sin Supabase ni `.env`) | 46/46                                                                                                                                                 |
| CI en GitHub Actions                                          | **Verde** en la primera ejecución: [run #1](https://github.com/posadfuj/plan/actions/runs/36383147690) (lint, tipos, migraciones, 46 tests, gitleaks) |
| Escaneo de secretos                                           | Sin hallazgos en el repositorio (solo el `.env` local, que no se sube)                                                                                |

## Cómo ver la demo

```bash
pnpm install
pnpm local:setup
pnpm demo
```

Recorre en orden:

1. **Login real** de 5 usuarios con Supabase Auth. La API valida los tokens (ES256, JWKS) igual que en producción.
2. **Panel del dueño:** resumen del negocio, clientes con su saldo y una ficha con historial y premios.
3. **Roles:**
   - el admin opera, pero no ve la auditoría;
   - un dueño no entra al panel maestro;
   - el superadmin ve el uso agregado de los negocios, pero **no** los datos de sus clientes.
4. **Aislamiento:**
   - la dueña del Café recibe 404 en todo lo de la Barbería;
   - con la sesión del Café, la base de datos devuelve 0 filas de la Barbería;
   - el historial de movimientos no se puede editar;
   - el mismo celular en dos negocios corresponde a dos clientes distintos.
5. **Suspensión** de la Veterinaria: el acceso queda bloqueado, se reactiva con todos los datos intactos y ambas acciones quedan en la auditoría.
6. **Wallet simulado:** un evento actualiza los pases Google y Apple simulados con el saldo de la base. Un fallo forzado de Google se reintenta solo.
7. **Google Wallet:** indica si ya están configuradas tus credenciales.

## Qué quedó terminado

| Entregable                | Detalle                                                                                                                                                       | Dónde                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Monorepo                  | pnpm + Turborepo, TypeScript estricto, ESLint, Prettier, Vitest                                                                                               | raíz                                                         |
| Entorno local             | Supabase CLI en Docker (Postgres 17 + Auth + Mailpit). `.env` generado automáticamente                                                                        | `supabase/`, `scripts/write-local-env.ts`                    |
| PostgreSQL y migraciones  | 30 tablas del modelo v1.1 en Drizzle + migración de seguridad. Chequeo automático de que esquema y migraciones coinciden                                      | `packages/db`                                                |
| Aislamiento multiempresa  | RLS forzado en **todas** las tablas con `organization_id` (un test falla si una tabla nueva queda sin RLS). La API usa un rol sin privilegios de salto de RLS | `packages/db/migrations/0001_security.sql`                   |
| Ledger inmutable          | Ni la API ni el administrador de la base pueden editar o borrar movimientos                                                                                   | ídem                                                         |
| Autenticación             | Supabase Auth; TOTP exigible para el superadmin (`AUTH_REQUIRE_SUPERADMIN_MFA`)                                                                               | `apps/api/src/auth`                                          |
| Roles                     | Matriz owner / admin / staff + permisos de plataforma, con tests                                                                                              | `packages/core/src/permissions.ts`                           |
| API                       | `/health`, `/v1/me`, resumen del negocio, clientes, ficha, auditoría y panel maestro (listar, suspender, reactivar)                                           | `apps/api`                                                   |
| Suite de aislamiento      | Base de datos (15 tests) y API (18 tests). Falla si se agrega un endpoint de negocio sin cubrirlo                                                             | `*.int.test.ts`                                              |
| Datos de prueba           | Barbería (sellos), Café (puntos) y Veterinaria (sellos): 72 clientes, ~800 movimientos, premios, canjes y pases simulados                                     | `packages/db/src/admin.ts`                                   |
| Wallet simulado           | Interfaz `WalletProvider`, proveedor simulado, outbox → pg-boss → sincronización con reintentos. Cada pase registra su cuenta emisora (`issuer_ref`)          | `packages/wallet`, `apps/worker`                             |
| Google Wallet (modo demo) | Generador del enlace "Guardar en Google Wallet" (JWT RS256), probado con una clave de prueba, + guía paso a paso                                              | `pnpm wallet:google-demo`, `docs/guia-google-wallet-demo.md` |
| CI                        | Formato, lint, tipos, consistencia de migraciones, tests unitarios y de integración con Postgres 17, más gitleaks                                             | `.github/workflows/ci.yml`                                   |

## Decisión de autenticación

**Supabase Auth**, como pediste. El análisis está en [`decisiones/0001-autenticacion.md`](./decisiones/0001-autenticacion.md).

- **Ventajas:**
  - Supabase mantiene contraseñas, recuperación, TOTP y límites de intentos.
  - Es menos código propio para una sola ingeniera.
  - Funciona completo en local. Lo verificamos esta semana, así que el argumento de "trabajar en local" ya no justificaba cambiar.
- **Desventajas:**
  - Los usuarios viven en Supabase: son exportables, pero hay dependencia.
  - El entorno local es más pesado: unos 2–3 GB de imágenes Docker.
- **Mitigación:** la API solo valida tokens. Cambiar de proveedor afecta un módulo, no el motor.

## Qué falló o hubo que corregir

| Problema                                                                                                         | Cómo se detectó                                       | Qué se hizo                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| El panel maestro mostraba **0 clientes** en todos los negocios (una subconsulta comparaba la columna equivocada) | La demo mostró el dato; el test solo contaba negocios | Corregido. El test ahora verifica los conteos exactos por negocio                                                     |
| pg-boss intentaba crear su esquema con el usuario de la API (sin permiso, como debe ser)                         | Test de integración del worker                        | La cola se instala en las migraciones con el usuario administrador; el worker arranca sin permisos de creación        |
| En Supabase, `postgres` no es superusuario y no podía asignar el esquema de la cola al rol de la API             | `db:reset`                                            | Mismo arreglo anterior (permisos explícitos)                                                                          |
| `pnpm setup` choca con un comando interno de pnpm                                                                | Revisión del README                                   | Renombrado a `pnpm local:setup`                                                                                       |
| Cuando Google falla, el reintento también reenvía a Apple                                                        | Log de la demo                                        | Es inofensivo (siempre envía el saldo actual), pero es trabajo repetido. **Pasa a la semana 2:** un job por proveedor |

## Ajustes técnicos respecto a los documentos (sin cambiar el alcance)

- **Entorno local:** Supabase CLI en lugar de docker-compose con Postgres 16, Mailpit y MinIO. Postgres pasa a la versión 17, la misma de Supabase. El almacenamiento de archivos se configura en la semana 5, cuando se sube el primer logo.
- **Reemisión de pases:** en `wallet_passes`, la regla "un pase por membresía y proveedor" pasa a "un pase **activo** por membresía y proveedor". Así, al reemitir, el pase anterior queda como `revoked` con su `issuer_ref` y convive con el nuevo. Esto deja lista la reemisión de Apple que pediste.
- **Correos en minúscula:** se validan con una regla de la base en lugar de la extensión `citext`, para no depender de extensiones.
- **Nombres de planes en los datos de prueba:** Start / Pro / Multi (tu decisión final sigue pendiente).

## Pendiente de tu lado (no bloquea la semana 2)

1. **Google Wallet en modo demo.** Sigue [`guia-google-wallet-demo.md`](./guia-google-wallet-demo.md): proyecto de Google Cloud, cuenta de servicio, cuenta emisora como persona individual y cuentas de prueba. Luego ejecutas `pnpm wallet:google-demo` y pruebas en 3–4 Android. Comparte la tabla de resultados.
2. Confirmar la **dedicación de la ingeniera** para ajustar el calendario.

## Qué pasa a la semana 2

- **Motor de fidelización** (plan original):
  - `computeEarn`, `applyGoal` con arrastre, límites, `computeRedeem`, `computeVoid` y `computeExpiration`;
  - el servicio de ledger con transacción, bloqueo e idempotencia, que será la primera fuente real de eventos del outbox;
  - tests de concurrencia.
- **Arrastrados:**
  - sincronización de Wallet con un job por proveedor;
  - la prueba de Google Wallet con tu cuenta, cuando la tengas.
- **Sin cambios:** túnel HTTPS en la semana 3 y PWA desde la semana 3.
