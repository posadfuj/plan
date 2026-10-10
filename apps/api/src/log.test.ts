import { DrizzleQueryError } from 'drizzle-orm/errors';
import { describe, expect, it } from 'vitest';
import { redactPath, safeError } from '@aiment/config';

describe('logs sin tokens ni datos personales', () => {
  it('reemplaza los tokens de la ruta y conserva ids, slugs y códigos cortos', () => {
    expect(redactPath('/v1/public/cards/4fK9qLmZ2xR7tYbN1cVw8e')).toBe('/v1/public/cards/:token');
    expect(redactPath('/v1/staff/scan/Ab3dEf6hIj9kLm2nOp5qRs')).toBe('/v1/staff/scan/:token');
    expect(redactPath('/v1/orgs/00000000-0000-4000-8000-0000000000a0/customers')).toBe(
      '/v1/orgs/00000000-0000-4000-8000-0000000000a0/customers',
    );
    expect(redactPath('/go/BRB2K')).toBe('/go/BRB2K');
  });

  it('un error de consulta no deja en el log los parámetros ni la fila de Postgres', () => {
    const pg = Object.assign(
      new Error('duplicate key value violates unique constraint "customers_org_phone"'),
      {
        code: '23505',
        constraint_name: 'customers_org_phone',
        detail: 'Key (organization_id, phone_e164)=(…, +51987654321) already exists.',
      },
    );
    const err = new DrizzleQueryError(
      'insert into "app"."customers" ("full_name", "phone_e164", "email") values ($1, $2, $3)',
      ['Ana Quispe', '+51987654321', 'ana@correo.pe'],
      pg,
    );
    const line = safeError(err);
    expect(line).toContain('consulta fallida (parámetros omitidos)');
    expect(line).toContain('pg 23505');
    expect(line).toContain('restricción customers_org_phone');
    for (const secret of ['Ana Quispe', '+51987654321', '987654321', 'ana@correo.pe', 'Key ('])
      expect(line).not.toContain(secret);
  });

  it('otros errores conservan su mensaje y el stack sin la primera línea', () => {
    const line = safeError(new TypeError('x is not a function'));
    expect(line.split('\n')[0]).toBe('TypeError · x is not a function');
    expect(line).toMatch(/\n\s+at /);
    expect(safeError('texto')).toBe('Error no estándar');
  });
});
