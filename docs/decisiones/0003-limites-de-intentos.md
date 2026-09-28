# ADR 0003: límites de intentos con IP compartida

- **Estado:** aceptada (semana 4, a pedido del fundador); se revisa con tráfico real en el piloto
- **Contexto:** los límites de la semana 3 eran por IP (5 registros cada 10 min). En producción muchos clientes comparten la misma IP pública: el Wi-Fi del local y, sobre todo, los operadores móviles en Perú, que ponen a miles de celulares detrás de una misma IP (CGNAT). Con 5 por IP, el sexto cliente de la mañana en la barbería quedaba bloqueado.

## Decisión

Dos capas:

1. **Por IP, holgado:** solo frena ráfagas (bots, scripts). No debe bloquear a un local con clientes.
2. **Por lo que identifica al intento**, que no depende de la IP: el celular o correo **dentro del negocio**, o el **dispositivo de caja**.

| Qué                               | Por IP (10 min) | Control fino                                                          |
| --------------------------------- | --------------- | --------------------------------------------------------------------- |
| Registro                          | 30              | 3 por celular y negocio cada 10 min                                   |
| Pedir enlace de recuperación      | 20              | 3 por contacto y negocio cada 10 min + 3 correos por hora por cliente |
| Abrir enlace de recuperación      | 30              | El enlace es de 128 bits, un solo uso y vence                         |
| Leer tarjeta / QR / landing       | 300 por minuto  | Tokens de 128 bits                                                    |
| Abrir QR de autorización de caja  | 10              | Código de 128 bits, un solo uso, 10 min                               |
| PIN de caja (abrir turno)         | —               | 5 intentos por persona → 15 min de bloqueo + 20 por dispositivo       |
| PIN del dueño (excepción en caja) | —               | 10 por dispositivo cada 15 min                                        |
| Búsqueda de clientes en caja      | —               | 30 por minuto por dispositivo                                         |

Probado: 12 clientes distintos desde la misma IP se registran sin bloqueo; el mismo celular se frena al 4.º intento aunque cambie de IP; la 31.ª ráfaga desde una IP se frena.

## Límites conocidos (y cuándo se resuelven)

- El contador está en memoria (una instancia). Al publicar con varias instancias (semana 9) pasa a Postgres o al borde (Cloudflare).
- Un bot que rote celulares falsos pasa el control por celular. Lo cubre **Turnstile** en el registro al publicar (semana 9), invisible para el cliente.
- Detrás del proxy, la IP sale de `X-Forwarded-For` solo si `TRUST_PROXY=true`; en producción debe venir de Cloudflare (`CF-Connecting-IP`).
- Los valores por IP son configurables por entorno (`RATE_LIMIT_*`) para ajustarlos con los datos del piloto sin tocar código.
