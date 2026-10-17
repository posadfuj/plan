# ADR 0005: cada persona de un negocio tiene un PIN distinto

- **Estado:** aceptada (17/10/2026, a pedido del fundador)
- **Contexto:** en caja, el PIN de excepción (para pasar un límite, como "ya sumó hace poco") lo escribe el dueño o un administrador **sin elegir su nombre**. El sistema busca de quién es ese PIN y lo registra en la auditoría como quien autorizó.

## Problema encontrado

Los datos de prueba le daban al dueño y a la administradora de la Barbería el mismo PIN (`1470`). Si dos personas que autorizan comparten PIN, el sistema recorría a los candidatos en un orden que la base de datos no garantiza y se quedaba con el primero. Cuando cambiaba ese orden (por ejemplo, después de que alguien actualizara su PIN), **la auditoría registraba como autorizante a la persona equivocada**. Lo destapó una prueba que fallaba según el orden en que corrían las demás. Fuera de las pruebas habría pasado igual.

## Decisión

1. **Un PIN distinto por persona dentro de cada negocio**: dueño, administradores y trabajadores de caja. Al crear a alguien o cambiar un PIN, si ya lo usa otra persona del negocio (también alguien dado de baja, para que reactivarlo no cree un duplicado), se rechaza: "Ese PIN ya lo usa otra persona del negocio". El mensaje no dice de quién es.
2. **Entre negocios distintos no hay restricción**: el mismo número puede existir en dos negocios.
3. **Datos viejos con PIN repetido**: si el PIN de excepción coincide con más de una persona que autoriza, **no se autoriza** (error `pin_ambiguous`, queda como intento fallido en la auditoría) y se pide al dueño que asigne PIN distintos. Nunca se adivina quién fue.
4. **Sin carreras**: el cambio de PIN bloquea el negocio durante la transacción, así que dos altas simultáneas con el mismo PIN no pueden pasar las dos.
5. **Sin adivinar PIN ajenos**: como "ya lo usa otra persona" revela que ese número existe, las altas y los cambios de PIN tienen un tope de 20 por persona del panel cada hora. Además, solo el dueño o un administrador puede definir PIN.

## Consecuencias

- Los PIN se guardan con sal (argon2id), así que no se pueden comparar directamente: cada cambio verifica el PIN nuevo contra el de cada persona del negocio. Con el tope del plan (hasta 50 trabajadores), cambiar un PIN puede tardar uno o dos segundos.
- Datos de prueba: Jhon `2580`, Mario `3691`, dueño `1470`, administradora `5928`.
- Pruebas de regresión en `apps/api/src/staff.int.test.ts` (PIN repetido, dado de baja, otro negocio, dos altas a la vez, tope de intentos y PIN ambiguo en caja).
