import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import { LoyaltyError } from '@aiment/core';
import { ServiceError } from '@aiment/ledger';
import { ZodError } from 'zod';
import type { AppDeps, AppEnv } from './context';
import { HttpError } from './errors';
import { adminRoutes } from './routes/admin';
import { loyaltyRoutes } from './routes/loyalty';
import { meRoutes } from './routes/me';
import { orgRoutes } from './routes/orgs';

/** Errores de datos de entrada (422); el resto de errores del motor son conflictos de estado (409). */
const VALIDATION_ERRORS = new Set<string>([
  'invalid_rule',
  'amount_required',
  'invalid_amount',
  'amount_too_low',
  'invalid_adjustment',
  'reason_required',
]);

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.use(requestId(), secureHeaders());
  app.use(async (c, next) => {
    c.set('deps', deps);
    await next();
  });

  app.get('/health', async (c) => {
    await deps.db.execute(sql`select 1`);
    return c.json({ status: 'ok', service: 'aiment-wallet-api' });
  });

  app.route('/v1/me', meRoutes);
  app.route('/v1/orgs/:orgId', orgRoutes);
  app.route('/v1/orgs/:orgId', loyaltyRoutes);
  app.route('/v1/admin', adminRoutes);

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Ruta no encontrada' } }, 404));
  app.onError((err, c) => {
    if (err instanceof HttpError)
      return c.json({ error: { code: err.code, message: err.message } }, err.status);
    if (err instanceof LoyaltyError)
      return c.json(
        { error: { code: err.code, message: err.message, details: err.details } },
        VALIDATION_ERRORS.has(err.code) ? 422 : 409,
      );
    if (err instanceof ServiceError)
      return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
    if (err instanceof ZodError)
      return c.json(
        { error: { code: 'invalid_request', message: 'Datos inválidos', issues: err.issues } },
        400,
      );
    console.error(`[api] ${c.get('requestId')} ${c.req.method} ${c.req.path}`, err);
    return c.json({ error: { code: 'internal_error', message: 'Error interno' } }, 500);
  });

  return app;
}

export type App = ReturnType<typeof createApp>;
