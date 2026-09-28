# Aiment Wallet: reporte de la semana 2

Fecha: 28/09/2026 · Alcance congelado: motor de puntos y sellos, premios, reglas, idempotencia, anulaciones y separación de Wallet por proveedor. No se agregaron funciones fuera del MVP.

## 1. Demo funcional

```bash
pnpm local:setup     # si es la primera vez (o pnpm db:reset para volver al estado inicial)
pnpm demo            # semana 2: 23 verificaciones
pnpm demo:semana-1   # la demo anterior sigue funcionando: 19 verificaciones
```

La demo usa logins reales de Supabase Auth y la API real, y se puede ejecutar varias veces seguidas:

1. **Sellos (Veterinaria, 6 = baño gratis):**
   - la 6.ª visita completa la meta: premio ganado y la tarjeta vuelve a 0;
   - una suma inmediata queda bloqueada por el cooldown;
   - el premio se canjea una vez y el segundo intento se rechaza;
   - no se puede anular la visita porque su premio ya se canjeó;
   - se anula el canje y el premio vuelve a estar disponible;
   - se anula la visita: se revierten la visita, la conversión y el premio, y queda en 5 sellos;
   - un movimiento no se anula dos veces.
2. **Puntos (Café, S/1 = 1 punto):**
   - S/ 45.90 suman 45 puntos;
   - sin monto responde 422;
   - el canje de catálogo descuenta 50 y al anularlo se devuelven.
3. **Límites (Barbería):**
   - una segunda suma dentro de 4 h se bloquea e indica desde cuándo reintentar;
   - el dueño la autoriza con motivo y queda en la auditoría;
   - el admin corrige con un ajuste negativo.
4. **Idempotencia y concurrencia:**
   - un reintento devuelve "replayed" sin duplicar;
   - 10 envíos simultáneos con la misma clave generan 1 movimiento;
   - 20 compras simultáneas dan el saldo exacto;
   - en toda la base, cada saldo coincide con la suma de sus movimientos.
5. **Wallet:** la suma llega a los pases Google y Apple. Google falla una vez y se reintenta solo; Apple se sincroniza **una sola vez**.

**Resultado: 23/23.**

## 2. Resultados de pruebas

| Suite                                   | Tests   | Qué cubre                                                                                                              |
| --------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| Unitarias: motor (`packages/core`)      | 28      | Reglas, montos en céntimos, metas con arrastre, bienvenida, límites, canjes, anulaciones, ajustes, expiración          |
| Unitarias: permisos y Wallet            | 8       | Matriz de roles, Wallet simulado, JWT de Google Wallet                                                                 |
| Integración: ledger (`packages/ledger`) | 37      | Transacciones reales, idempotencia, anulaciones, límites, bienvenida, versiones de regla, expiración, **concurrencia** |
| Integración: API                        | 22      | Aislamiento (14 rutas), roles, códigos HTTP, flujo por HTTP                                                            |
| Integración: base de datos (RLS)        | 15      | Sin cambios; siguen en verde                                                                                           |
| Integración: Wallet/worker              | 7       | Una cola por proveedor, fallo aislado, suma real → pases                                                               |
| **Total**                               | **117** |                                                                                                                        |

- **Cobertura del motor:** 99,2 % de líneas y 98,3 % de ramas (100 % en los archivos del motor). CI exige un mínimo de 90 %.
- **Estabilidad:** suite completa 3 veces seguidas en verde, más una simulación de CI (Postgres 17 limpio, sin Supabase ni `.env`): 117/117.
- **CI en GitHub Actions:** verde ([run #3](https://github.com/posadfuj/plan/actions/runs/36386842677)): formato, lint, tipos, consistencia de migraciones, cobertura mínima, 117 tests y gitleaks.
- **Concurrencia probada contra PostgreSQL real:**

| Escenario                                      | Resultado                                                  |
| ---------------------------------------------- | ---------------------------------------------------------- |
| 20 sumas simultáneas al mismo cliente          | Saldo exacto; saldos intermedios 10, 20, …, 200 sin huecos |
| 20 sumas simultáneas con cooldown activo       | Pasa **1**, se rechazan 19                                 |
| 10 reintentos simultáneos con la misma clave   | **1** movimiento                                           |
| 5 canjes simultáneos del mismo premio          | Pasa **1**                                                 |
| 5 anulaciones simultáneas del mismo movimiento | Pasa **1**, las otras 4 reciben `already_voided`           |

- **Seguridad que se mantiene:** todas las pruebas de aislamiento de la semana 1 siguen en verde. La suite de la API ahora cubre **14 rutas**, incluidas todas las de escritura: el dueño de otro negocio recibe 404 en todas y una foto del negocio A antes y después demuestra que no cambió nada.

## 3. Qué quedó terminado

| Entregable                            | Detalle                                                                                                                                                                                                                                                                                |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Motor puro                            | Reglas validadas (sellos exigen meta; puntos usan catálogo), montos en céntimos, metas con arrastre, bono de bienvenida, límites, canjes, anulaciones, ajustes y expiración por meses de calendario                                                                                    |
| Servicio de ledger (`@aiment/ledger`) | `earn`, `redeem`, `adjust`, `voidEntry` y `voidRedemption`. Cada operación en una transacción con bloqueo del cliente, idempotencia con respuesta original, saldo materializado, eventos y auditoría                                                                                   |
| Premios ganados                       | Separados del canje. Se generan al completar la meta o por la bienvenida, con vigencia, y solo se canjean una vez                                                                                                                                                                      |
| Anulaciones                           | Nunca se edita el pasado: se crean reversas. Al anular una suma se revierte también lo que generó (conversión, premio no usado, bono). Si el premio ya se canjeó, se bloquea. El trabajador solo anula su último movimiento, dentro de 15 min; el dueño o admin, cualquiera con motivo |
| Límites                               | Cooldown por cliente, máximo por operación y tope diario por trabajador. Override solo de dueño o admin, con motivo y auditado                                                                                                                                                         |
| Bono de bienvenida                    | En la 1.ª visita validada, nunca al registrarse. Si esa visita se anula, el bono también se anula y vuelve a quedar pendiente                                                                                                                                                          |
| Reglas versionadas                    | Cambiar la regla crea una versión nueva; cada movimiento conserva la versión con la que se calculó                                                                                                                                                                                     |
| Premios                               | Alta y edición con validación por modo. Un solo premio de meta activo                                                                                                                                                                                                                  |
| Expiración                            | Función lista e idempotente. Con el valor del piloto (sin expiración) no hace nada                                                                                                                                                                                                     |
| API                                   | 10 rutas nuevas: programa, reglas, premios, membresía, suma, canje, ajuste y anulaciones. Clave `Idempotency-Key` obligatoria; 201 si es nueva, 200 + `Idempotent-Replayed` si es un reintento                                                                                         |
| Wallet por proveedor                  | Colas `wallet.sync.google` y `wallet.sync.apple`. Solo se encola donde el cliente tiene pase, y varios eventos de un mismo cliente en un lote generan un solo job por proveedor                                                                                                        |
| Migración                             | `0002`: `caused_by_entry_id` en el ledger, que vincula una suma con la conversión o el bono que generó                                                                                                                                                                                 |

## 4. Errores encontrados y corregidos

| Error                                                                                                                         | Cómo se detectó                                | Corrección                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Postgres rechaza `FOR UPDATE OF "app"."memberships"` tal como lo genera Drizzle                                               | Tests del ledger                               | El bloqueo se hace con una consulta simple sobre la tabla y luego se lee el contexto         |
| **Búsqueda de reintentos con `LIKE`:** `_` es comodín, y una clave con `_` podía arrastrar movimientos de otra clave parecida | Revisión del propio código                     | Comparación exacta de prefijo + test específico (`k_vecina1` frente a `kXvecina1`)           |
| El tope diario se aplicaba también al dueño                                                                                   | Test de override                               | El tope diario es un control de caja: solo aplica a trabajadores. El cooldown aplica a todos |
| Riesgo de repetir el bug de la semana 1 (subconsulta que compara contra la columna equivocada)                                | Prevención al escribir "movimiento no anulado" | Referencia explícita a la fila externa                                                       |
| Test inestable: esperaba exactamente 3 negocios, pero el ledger crea los suyos                                                | 1 de 3 ejecuciones falló                       | Verifica los 3 negocios del seed sin exigir el total                                         |
| Carrera en el test del worker: el despachador automático competía con el manual                                               | Revisión del test                              | Opción `autoDispatch: false` para tests deterministas                                        |
| La demo medía Wallet sobre un cliente con sincronizaciones previas pendientes                                                 | Demo (22/23)                                   | Cliente distinto y conteo solo de llamadas nuevas → 23/23                                    |

## 5. Deuda técnica y pendientes que pasan a la semana 3

| #   | Tema                                                                                                                    | Por qué se deja                                                                                             | Cuándo                           |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 1   | **Endpoints de caja** (dispositivo autorizado + PIN)                                                                    | Es la semana 4 del backlog. El servicio ya está listo: la caja lo reutilizará sin cambios                   | Semana 4                         |
| 2   | Anular una suma **anterior** a la que completó la meta responde "dejaría el saldo en negativo"                          | La regla es correcta (hay que anular primero la suma que completó la meta), pero el mensaje debería decirlo | Semana 4 (mensajes de caja)      |
| 3   | El job de expiración existe pero **no está programado**                                                                 | En el piloto la expiración está desactivada                                                                 | Semana 6 (cron por zona horaria) |
| 4   | Evento `program.updated` sin consumidor (cambio de regla o meta → actualizar la clase de Google y los pases)            | Lo necesita el Wallet real                                                                                  | Semana 7                         |
| 5   | La idempotencia de "anular canje de premio ganado" se apoya en la auditoría (esa anulación no crea movimiento de saldo) | Funciona y está probado, pero es un caso especial                                                           | Revisar en semana 6              |
| 6   | En el ledger, dueño y admin se registran como `actor_type = owner`; se distinguen por `actor_id`                        | Sin impacto funcional; los reportes por usuario usan `actor_id`                                             | —                                |
| 7   | La cobertura se mide solo en el motor puro                                                                              | El servicio se cubre con 37 tests de integración, pero sin porcentaje medido                                | Semana 6 (hardening)             |
| 8   | **Prueba real de Google Wallet** en Android                                                                             | Depende de tu cuenta emisora en modo demo                                                                   | Cuando la tengas                 |

**Semana 3, sin cambios de alcance:** URLs cortas `/go/`, registro `/join/`, dos tokens, tarjeta web `/m/`, página `/s/`, recuperación por correo y túnel HTTPS para probar con celulares.
