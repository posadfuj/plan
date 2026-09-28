# ADR 0001: autenticación con Supabase Auth

- **Estado:** aceptada (semana 1)
- **Contexto:** la arquitectura v1.1 proponía Better Auth para no depender de Supabase al trabajar en local. El fundador pidió no cambiar de proveedor solo por eso y elegir la opción más conveniente y sostenible.

## Opciones

|                                                                | Supabase Auth                                                                    | Better Auth (librería en la API)                                    |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Seguridad de contraseñas, recuperación, confirmación de correo | La mantiene Supabase                                                             | La mantenemos nosotros (librería + configuración + actualizaciones) |
| TOTP / MFA                                                     | Incluido (`aal2` en el token)                                                    | Plugin, lo configuramos nosotros                                    |
| Límites de intentos y protección de fuerza bruta               | Incluidos                                                                        | Hay que configurarlos                                               |
| Trabajo en local                                               | `supabase start` (Docker): Postgres + Auth + Mailpit                             | Solo Postgres                                                       |
| Tests automáticos                                              | Tokens firmados en el test; no hace falta levantar Auth                          | Igual de simple                                                     |
| Dependencia de proveedor                                       | Los usuarios viven en Supabase (exportables; los hashes bcrypt se pueden migrar) | Ninguna                                                             |
| Código que mantiene la ingeniera                               | Mínimo: validar tokens (JWKS)                                                    | Más: tablas, sesiones, correos y flujos                             |
| Costo                                                          | Incluido en Supabase (plan Pro en producción)                                    | US$0                                                                |

## Decisión

**Supabase Auth.** El argumento a favor de Better Auth era trabajar en local sin Supabase, pero Supabase CLI corre completo en Docker (lo verificamos en la semana 1: Postgres 17 + Auth + Mailpit). Con eso desaparece la ventaja principal. Con una sola ingeniera, delegar la parte más delicada (contraseñas, recuperación, MFA, fuerza bruta) a un servicio mantenido es más sostenible que mantenerla nosotros.

## Cómo se implementó (para no quedar atados)

- La API **solo valida** access tokens: `apps/api/src/auth/verifier.ts`.
  - Producción y local: claves asimétricas (ES256) vía JWKS publicado por Supabase.
  - HS256 solo para tests y proyectos legacy.
- Los datos de negocio (roles, organizaciones) viven en nuestro esquema `app`, no en Supabase. `app.users.id` = id de Supabase Auth.
- La clave secreta de Supabase (`SUPABASE_SECRET_KEY`) solo la usan el seed y, desde la semana 5, las invitaciones de dueños. Nunca va al frontend.
- Cambiar de proveedor en el futuro afecta el verificador de tokens y el alta de usuarios; el motor de fidelización no se toca.
- Los trabajadores de caja no usan Supabase Auth: entran con dispositivo autorizado + PIN (semana 4).
