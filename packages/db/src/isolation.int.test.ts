/**
 * Aislamiento multiempresa a nivel de base de datos (segunda capa, RLS).
 * Se conecta como el usuario de la API (miembro de app_api, sin BYPASSRLS).
 */
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import postgres from 'postgres';
import { SEED, seedMembershipId } from './seed-data';

const A = SEED.orgs.barberia;
const B = SEED.orgs.cafe;

let api: postgres.Sql;
let admin: postgres.Sql;
let tenantTables: string[] = [];

/** Ejecuta `fn` en una transacción con el contexto de tenant indicado y la revierte al final. */
async function asTenant<T>(
  orgId: string | null,
  fn: (sql: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  let result: T;
  await api
    .begin(async (sql) => {
      if (orgId) await sql`select set_config('app.org_id', ${orgId}, true)`;
      result = await fn(sql);
      throw new Rollback();
    })
    .catch((e) => {
      if (!(e instanceof Rollback)) throw e;
    });
  return result!;
}
class Rollback extends Error {}

beforeAll(async () => {
  api = postgres(inject('apiDbUrl'), { max: 2, onnotice: () => {} });
  admin = postgres(inject('adminUrl'), { max: 1, onnotice: () => {} });
  const rows = await admin`
    select c.table_name from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'app' and c.column_name = 'organization_id' and t.table_type = 'BASE TABLE'
    order by 1`;
  tenantTables = rows.map((r) => r.table_name as string);
});

afterAll(async () => {
  await api?.end();
  await admin?.end();
});

describe('RLS: cobertura', () => {
  it('toda tabla con organization_id tiene RLS habilitado y forzado', async () => {
    expect(tenantTables.length).toBeGreaterThanOrEqual(20);
    const rows = await admin`
      select relname, relrowsecurity, relforcerowsecurity from pg_class
      where relnamespace = 'app'::regnamespace and relname = any(${[...tenantTables, 'organizations']})`;
    const missing = rows.filter((r) => !r.relrowsecurity || !r.relforcerowsecurity).map((r) => r.relname);
    expect(missing).toEqual([]);
  });

  it('el usuario de la API no tiene BYPASSRLS ni es superusuario', async () => {
    const [me] = await api`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
    expect(me).toMatchObject({ rolsuper: false, rolbypassrls: false });
  });
});

describe('RLS: lectura', () => {
  it('sin contexto de tenant no se ve ninguna fila', async () => {
    const counts = await asTenant(null, async (sql) => {
      const out: Record<string, number> = {};
      for (const t of [...tenantTables, 'organizations'])
        out[t] = Number((await sql.unsafe(`select count(*)::int as n from app.${t}`))[0]!.n);
      return out;
    });
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
  });

  it('el negocio B no ve ninguna fila del negocio A en ninguna tabla', async () => {
    const leaks = await asTenant(B.id, async (sql) => {
      const out: string[] = [];
      for (const t of tenantTables) {
        const [r] = await sql.unsafe(`select count(*)::int as n from app.${t} where organization_id = $1`, [
          A.id,
        ]);
        if (r!.n > 0) out.push(t);
      }
      const [o] = await sql`select count(*)::int as n from app.organizations where id = ${A.id}`;
      if (o!.n > 0) out.push('organizations');
      return out;
    });
    expect(leaks).toEqual([]);
  });

  it('cada negocio ve sus propios datos', async () => {
    const n = await asTenant(
      A.id,
      async (sql) => (await sql`select count(*)::int as n from app.customers`)[0]!.n,
    );
    expect(n).toBe(A.customers);
  });

  it('el mismo celular en dos negocios son dos clientes independientes', async () => {
    const inA = await asTenant(
      A.id,
      (sql) => sql`select id from app.customers where phone_e164 = ${SEED.sharedPhone}`,
    );
    const inC = await asTenant(
      SEED.orgs.veterinaria.id,
      (sql) => sql`select id from app.customers where phone_e164 = ${SEED.sharedPhone}`,
    );
    expect(inA).toHaveLength(1);
    expect(inC).toHaveLength(1);
    expect(inA[0]!.id).not.toBe(inC[0]!.id);
  });
});

describe('RLS: escritura', () => {
  it('el negocio B no puede insertar filas a nombre de A', async () => {
    await expect(
      asTenant(
        B.id,
        (sql) =>
          sql`insert into app.customers (organization_id, full_name, phone_e164) values (${A.id}, 'Intruso', '+51900000000')`,
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('el negocio B no puede modificar ni borrar filas de A (0 filas afectadas)', async () => {
    const result = await asTenant(B.id, async (sql) => {
      const upd = await sql`update app.memberships set balance = 999 where organization_id = ${A.id}`;
      const del = await sql`delete from app.customer_consents where organization_id = ${A.id}`;
      return { upd: upd.count, del: del.count };
    });
    expect(result).toEqual({ upd: 0, del: 0 });
  });

  it('el negocio B no puede mover una fila propia hacia A', async () => {
    await expect(
      asTenant(
        B.id,
        (sql) => sql`update app.customers set organization_id = ${A.id} where organization_id = ${B.id}`,
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe('Ledger inmutable', () => {
  const membershipId = seedMembershipId('barberia', 1);

  it('la API no tiene permiso de UPDATE/DELETE sobre el ledger', async () => {
    await expect(
      asTenant(
        A.id,
        (sql) => sql`update app.ledger_entries set delta = 50 where membership_id = ${membershipId}`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asTenant(A.id, (sql) => sql`delete from app.ledger_entries where membership_id = ${membershipId}`),
    ).rejects.toThrow(/permission denied/);
  });

  it('ni siquiera el administrador de la base puede editar o borrar movimientos', async () => {
    await expect(
      admin`update app.ledger_entries set delta = 50 where membership_id = ${membershipId}`,
    ).rejects.toThrow(/inmutable/);
    await expect(admin`delete from app.ledger_entries where membership_id = ${membershipId}`).rejects.toThrow(
      /inmutable/,
    );
  });

  it('una clave de idempotencia repetida no crea un segundo movimiento', async () => {
    await expect(
      asTenant(A.id, async (sql) => {
        const row = {
          organization_id: A.id,
          membership_id: membershipId,
          kind: 'adjust',
          delta: 1,
          rule_version_id: A.ruleVersionId,
          actor_type: 'owner',
          reason: 'test',
          idempotency_key: 'test-dup',
          balance_after: 1,
        };
        await sql`insert into app.ledger_entries ${sql(row)}`;
        await sql`insert into app.ledger_entries ${sql(row)}`;
      }),
    ).rejects.toThrow(/ledger_entries_org_idempotency_uniq/);
  });

  it('la auditoría tampoco se puede editar', async () => {
    await expect(
      asTenant(A.id, async (sql) => {
        await sql`insert into app.audit_logs (organization_id, actor_type, action, entity_type) values (${A.id}, 'owner', 'test', 'test')`;
        await sql`update app.audit_logs set action = 'x'`;
      }),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('Datos de prueba', () => {
  it('los saldos materializados coinciden con la suma del ledger', async () => {
    const mismatches = await admin`
      select m.id from app.memberships m
      left join app.ledger_entries l on l.membership_id = m.id
      group by m.id, m.balance having m.balance <> coalesce(sum(l.delta), 0)`;
    expect(mismatches).toHaveLength(0);
  });

  it('existen premios ganados, canjes y pases simulados en cada negocio', async () => {
    const [r] = await admin`
      select (select count(*) from app.earned_rewards)::int as earned,
             (select count(*) from app.redemptions)::int as redemptions,
             (select count(distinct organization_id) from app.wallet_passes)::int as orgs_with_passes`;
    expect(r!.earned).toBeGreaterThan(0);
    expect(r!.redemptions).toBeGreaterThan(0);
    expect(r!.orgs_with_passes).toBe(3);
  });
});
