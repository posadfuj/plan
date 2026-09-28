/**
 * Servicio de ledger contra PostgreSQL real, con el rol de la API (RLS activo).
 * Cada bloque crea su propio negocio de prueba.
 */
import { LoyaltyError } from '@aiment/core';
import { createDb, schema, withSystemTx, type DbHandle } from '@aiment/db';
import { SEED, seedMembershipId } from '@aiment/db/seed-data';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { adjust, earn, expireInactive, redeem, voidEntry, voidRedemption } from './ledger';
import { createReward, createRuleVersion, getProgram, updateReward } from './programs';
import { createTestOrg, type TestOrg } from './test-fixtures';
import { ServiceError } from './types';

let h: DbHandle;
const key = () => `k_${randomUUID().replaceAll('-', '')}`;
const HOUR = 3_600_000;
const t0 = new Date('2026-10-01T13:00:00Z');
const at = (hours: number) => new Date(t0.getTime() + hours * HOUR);

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof LoyaltyError || e instanceof ServiceError) return e.code;
    throw e;
  }
  return 'ok';
}

async function ledgerSum(membershipId: string) {
  const [r] = await withSystemTx(h.db, (tx) =>
    tx.execute(sql`
      select m.balance, coalesce(sum(l.delta), 0)::int as sum, coalesce(min(l.balance_after), 0)::int as min_after
      from app.memberships m left join app.ledger_entries l on l.membership_id = m.id
      where m.id = ${membershipId} group by m.balance`),
  );
  return r as { balance: number; sum: number; min_after: number };
}

async function outboxTypes(membershipId: string) {
  const rows = await withSystemTx(h.db, (tx) =>
    tx
      .select({ type: schema.eventOutbox.type })
      .from(schema.eventOutbox)
      .where(eq(schema.eventOutbox.aggregateId, membershipId))
      .orderBy(schema.eventOutbox.id),
  );
  return rows.map((r) => r.type);
}

beforeAll(() => {
  h = createDb(inject('apiDbUrl'), { max: 25 });
});
afterAll(() => h?.close());

describe('sellos: meta, premio y canje', () => {
  let org: TestOrg;
  beforeAll(async () => {
    org = await createTestOrg(h.db, { mode: 'stamps', goal: 10, limits: { cooldown_minutes: 240 } });
  });

  it('10 visitas → 1 premio ganado, el saldo vuelve a 0 y el ledger cuadra', async () => {
    const m = await org.newMembership();
    let last;
    for (let i = 0; i < 10; i++)
      last = await earn(h.db, org.orgId, {
        membershipId: m,
        operator: org.staff,
        idempotencyKey: key(),
        now: at(i * 5),
      });
    expect(last!.membership.balance).toBe(0);
    expect(last!.entries.map((e) => [e.kind, e.delta, e.balanceAfter])).toEqual([
      ['earn', 1, 10],
      ['convert', -10, 0],
    ]);
    expect(last!.entries[1]!.causedByEntryId).toBe(last!.entries[0]!.id);
    expect(last!.earnedRewards).toEqual([
      expect.objectContaining({ source: 'goal', status: 'available', rewardId: org.goalRewardId }),
    ]);
    expect(last!.membership.availableRewards).toHaveLength(1);
    expect(last!.membership.lifetimeEarned).toBe(10);
    expect(await ledgerSum(m)).toMatchObject({ balance: 0, sum: 0 });
    const types = await outboxTypes(m);
    expect(types.filter((t) => t === 'ledger.created')).toHaveLength(10);
    expect(types.filter((t) => t === 'reward.earned')).toHaveLength(1);
  });

  it('el excedente se arrastra (ajuste de +12 con meta 10 → 1 premio y quedan 2)', async () => {
    const m = await org.newMembership();
    const r = await adjust(h.db, org.orgId, {
      membershipId: m,
      delta: 12,
      reason: 'Migración de tarjeta física',
      operator: org.owner,
      idempotencyKey: key(),
    });
    expect(r.membership.balance).toBe(2);
    expect(r.earnedRewards).toHaveLength(1);
  });

  it('el premio ganado se canjea UNA sola vez', async () => {
    const m = await org.newMembership();
    const g = await adjust(h.db, org.orgId, {
      membershipId: m,
      delta: 10,
      reason: 'Premio de prueba',
      operator: org.owner,
      idempotencyKey: key(),
    });
    const earnedRewardId = g.earnedRewards[0]!.id;
    const r1 = await redeem(h.db, org.orgId, {
      membershipId: m,
      earnedRewardId,
      operator: org.staff,
      idempotencyKey: key(),
    });
    expect(r1.redemption).toMatchObject({ status: 'completed' });
    expect(r1.entries).toEqual([]); // el canje de un premio ganado no mueve saldo
    expect(r1.membership.availableRewards).toHaveLength(0);
    expect(
      await codeOf(
        redeem(h.db, org.orgId, {
          membershipId: m,
          earnedRewardId,
          operator: org.staff,
          idempotencyKey: key(),
        }),
      ),
    ).toBe('reward_not_available');
  });

  it('la misma clave de canje devuelve la operación original', async () => {
    const m = await org.newMembership();
    const g = await adjust(h.db, org.orgId, {
      membershipId: m,
      delta: 10,
      reason: 'Premio de prueba',
      operator: org.owner,
      idempotencyKey: key(),
    });
    const k = key();
    const input = {
      membershipId: m,
      earnedRewardId: g.earnedRewards[0]!.id,
      operator: org.staff,
      idempotencyKey: k,
    };
    const r1 = await redeem(h.db, org.orgId, input);
    const r2 = await redeem(h.db, org.orgId, input);
    expect(r2.replayed).toBe(true);
    expect(r2.redemption!.id).toBe(r1.redemption!.id);
  });

  it('un premio vencido no se canjea y el job de expiración lo marca', async () => {
    const m = await org.newMembership();
    const g = await adjust(h.db, org.orgId, {
      membershipId: m,
      delta: 10,
      reason: 'Premio de prueba',
      operator: org.owner,
      idempotencyKey: key(),
    });
    const future = new Date(Date.now() + 31 * 24 * HOUR); // vigencia del premio: 30 días
    expect(
      await codeOf(
        redeem(h.db, org.orgId, {
          membershipId: m,
          earnedRewardId: g.earnedRewards[0]!.id,
          operator: org.staff,
          idempotencyKey: key(),
          now: future,
        }),
      ),
    ).toBe('reward_expired');
    const r = await expireInactive(h.db, org.orgId, future);
    expect(r.expiredRewards).toBeGreaterThanOrEqual(1);
  });

  it('un programa de sellos sin premio de meta activo no deja completar la tarjeta', async () => {
    const other = await createTestOrg(h.db, { mode: 'stamps', goal: 2 });
    await updateReward(h.db, other.orgId, other.owner, other.goalRewardId!, { active: false });
    const m = await other.newMembership();
    await earn(h.db, other.orgId, { membershipId: m, operator: other.staff, idempotencyKey: key() });
    expect(
      await codeOf(
        earn(h.db, other.orgId, { membershipId: m, operator: other.staff, idempotencyKey: key() }),
      ),
    ).toBe('reward_not_available');
    expect((await ledgerSum(m)).balance).toBe(1); // la transacción fallida no dejó rastro
  });
});

describe('puntos: monto, catálogo y anulación de canje', () => {
  let org: TestOrg;
  beforeAll(async () => {
    org = await createTestOrg(h.db, { mode: 'points', limits: { max_amount_per_tx: 500 } });
  });

  it('suma según el monto (S/1 = 1 punto, redondeo hacia abajo) y canjea contra el catálogo', async () => {
    const m = await org.newMembership();
    const e = await earn(h.db, org.orgId, {
      membershipId: m,
      amount: '25.90',
      operator: org.staff,
      idempotencyKey: key(),
    });
    expect(e.membership.balance).toBe(25);
    const cafe = org.catalog[0]!;
    expect(
      await codeOf(
        redeem(h.db, org.orgId, {
          membershipId: m,
          rewardId: cafe.id,
          operator: org.staff,
          idempotencyKey: key(),
        }),
      ),
    ).toBe('insufficient_balance');
    await earn(h.db, org.orgId, { membershipId: m, amount: 30, operator: org.staff, idempotencyKey: key() });
    const r = await redeem(h.db, org.orgId, {
      membershipId: m,
      rewardId: cafe.id,
      operator: org.staff,
      idempotencyKey: key(),
    });
    expect(r.entries.map((x) => [x.kind, x.delta, x.balanceAfter])).toEqual([['redeem', -50, 5]]);

    const v = await voidRedemption(h.db, org.orgId, {
      redemptionId: r.redemption!.id,
      reason: 'Cliente cambió de opinión',
      operator: org.staff,
      idempotencyKey: key(),
    });
    expect(v.membership.balance).toBe(55);
    expect(v.redemption!.status).toBe('voided');
    expect(await ledgerSum(m)).toMatchObject({ balance: 55, sum: 55 });
  });

  it('exige monto y respeta el máximo por operación', async () => {
    const m = await org.newMembership();
    expect(
      await codeOf(earn(h.db, org.orgId, { membershipId: m, operator: org.staff, idempotencyKey: key() })),
    ).toBe('amount_required');
    expect(
      await codeOf(
        earn(h.db, org.orgId, {
          membershipId: m,
          amount: '0.50',
          operator: org.staff,
          idempotencyKey: key(),
        }),
      ),
    ).toBe('amount_too_low');
    expect(
      await codeOf(
        earn(h.db, org.orgId, { membershipId: m, amount: 800, operator: org.staff, idempotencyKey: key() }),
      ),
    ).toBe('max_amount_per_tx');
  });

  it('no se puede anular una suma si los puntos ya se gastaron', async () => {
    const m = await org.newMembership();
    const e = await earn(h.db, org.orgId, {
      membershipId: m,
      amount: 60,
      operator: org.owner,
      idempotencyKey: key(),
    });
    await redeem(h.db, org.orgId, {
      membershipId: m,
      rewardId: org.catalog[0]!.id,
      operator: org.owner,
      idempotencyKey: key(),
    });
    expect(
      await codeOf(
        voidEntry(h.db, org.orgId, {
          entryId: e.entries[0]!.id,
          reason: 'Error',
          operator: org.owner,
          idempotencyKey: key(),
        }),
      ),
    ).toBe('balance_would_be_negative');
  });
});

describe('idempotencia', () => {
  let org: TestOrg;
  beforeAll(async () => {
    org = await createTestOrg(h.db, { mode: 'points' });
  });

  it('reintentar con la misma clave no duplica y devuelve el mismo movimiento', async () => {
    const m = await org.newMembership();
    const k = key();
    const r1 = await earn(h.db, org.orgId, {
      membershipId: m,
      amount: 10,
      operator: org.staff,
      idempotencyKey: k,
    });
    const r2 = await earn(h.db, org.orgId, {
      membershipId: m,
      amount: 10,
      operator: org.staff,
      idempotencyKey: k,
    });
    expect([r1.replayed, r2.replayed]).toEqual([false, true]);
    expect(r2.entries[0]!.id).toBe(r1.entries[0]!.id);
    expect(r2.membership.balance).toBe(10);
  });

  it('la misma clave para otra membresía u otra operación → 409', async () => {
    const m1 = await org.newMembership();
    const m2 = await org.newMembership();
    const k = key();
    await earn(h.db, org.orgId, { membershipId: m1, amount: 10, operator: org.staff, idempotencyKey: k });
    expect(
      await codeOf(
        earn(h.db, org.orgId, { membershipId: m2, amount: 10, operator: org.staff, idempotencyKey: k }),
      ),
    ).toBe('idempotency_key_reused');
    expect(
      await codeOf(
        adjust(h.db, org.orgId, {
          membershipId: m1,
          delta: 1,
          reason: 'Ajuste de prueba',
          operator: org.owner,
          idempotencyKey: k,
        }),
      ),
    ).toBe('idempotency_key_reused');
  });

  it('claves parecidas no se mezclan en la respuesta de un reintento (sin comodines)', async () => {
    const org = await createTestOrg(h.db, { mode: 'stamps', goal: 2 });
    const m1 = await org.newMembership();
    const m2 = await org.newMembership();
    await adjust(h.db, org.orgId, {
      membershipId: m2,
      delta: 2,
      reason: 'Clave vecina',
      operator: org.owner,
      idempotencyKey: 'kXvecina1',
    });
    const k = 'k_vecina1';
    await earn(h.db, org.orgId, { membershipId: m1, operator: org.owner, idempotencyKey: k });
    const replay = await earn(h.db, org.orgId, { membershipId: m1, operator: org.owner, idempotencyKey: k });
    expect(replay.replayed).toBe(true);
    expect(replay.entries).toHaveLength(1);
  });

  it('rechaza claves ausentes o mal formadas', async () => {
    const m = await org.newMembership();
    for (const bad of ['', 'corta', 'con espacios 123', 'x'.repeat(101), 'a#b-comodín'])
      expect(
        await codeOf(
          earn(h.db, org.orgId, { membershipId: m, amount: 10, operator: org.staff, idempotencyKey: bad }),
        ),
      ).toBe('idempotency_key_required');
  });
});

describe('anulaciones', () => {
  let org: TestOrg;
  beforeAll(async () => {
    org = await createTestOrg(h.db, { mode: 'stamps', goal: 3 });
  });

  it('anular la suma que completó la meta revierte el premio (si no se usó) y deja el saldo como antes', async () => {
    const m = await org.newMembership();
    await earn(h.db, org.orgId, { membershipId: m, operator: org.staff, idempotencyKey: key() });
    await earn(h.db, org.orgId, { membershipId: m, operator: org.staff, idempotencyKey: key() });
    const third = await earn(h.db, org.orgId, {
      membershipId: m,
      operator: org.staff,
      idempotencyKey: key(),
    });
    expect(third.membership.balance).toBe(0);
    const v = await voidEntry(h.db, org.orgId, {
      entryId: third.entries[0]!.id,
      reason: 'Sumé dos veces',
      operator: org.staff,
      idempotencyKey: key(),
    });
    expect(v.membership.balance).toBe(2);
    expect(v.membership.availableRewards).toHaveLength(0);
    expect(v.earnedRewards[0]!.status).toBe('voided');
    expect(v.entries.every((e) => e.kind === 'reversal')).toBe(true);
    expect(v.entries.map((e) => e.delta).sort()).toEqual([-1, 3]);
    expect(await ledgerSum(m)).toMatchObject({ balance: 2, sum: 2 });
    expect((await ledgerSum(m)).min_after).toBeGreaterThanOrEqual(0);
  });

  it('anular una visita anterior a la que completó la meta explica qué anular primero', async () => {
    const m = await org.newMembership();
    const first = await earn(h.db, org.orgId, {
      membershipId: m,
      operator: org.owner,
      idempotencyKey: key(),
    });
    await earn(h.db, org.orgId, { membershipId: m, operator: org.owner, idempotencyKey: key() });
    const third = await earn(h.db, org.orgId, {
      membershipId: m,
      operator: org.owner,
      idempotencyKey: key(),
    });
    expect(third.membership.balance).toBe(0); // la 3.ª completó la meta
    const blocked = voidEntry(h.db, org.orgId, {
      entryId: first.entries[0]!.id,
      reason: 'Error',
      operator: org.owner,
      idempotencyKey: key(),
    });
    expect(await codeOf(blocked)).toBe('void_blocked_by_later_goal');
    // Anulando primero la que completó la meta, luego sí se puede anular la anterior.
    await voidEntry(h.db, org.orgId, {
      entryId: third.entries[0]!.id,
      reason: 'Error',
      operator: org.owner,
      idempotencyKey: key(),
    });
    const ok = await voidEntry(h.db, org.orgId, {
      entryId: first.entries[0]!.id,
      reason: 'Error',
      operator: org.owner,
      idempotencyKey: key(),
    });
    expect(ok.membership.balance).toBe(1);
  });

  it('si el premio generado ya se canjeó, la anulación se bloquea', async () => {
    const m = await org.newMembership();
    let last;
    for (let i = 0; i < 3; i++)
      last = await earn(h.db, org.orgId, { membershipId: m, operator: org.owner, idempotencyKey: key() });
    await redeem(h.db, org.orgId, {
      membershipId: m,
      earnedRewardId: last!.earnedRewards[0]!.id,
      operator: org.owner,
      idempotencyKey: key(),
    });
    expect(
      await codeOf(
        voidEntry(h.db, org.orgId, {
          entryId: last!.entries[0]!.id,
          reason: 'Error',
          operator: org.owner,
          idempotencyKey: key(),
        }),
      ),
    ).toBe('reward_already_redeemed');
  });

  it('un movimiento no se anula dos veces; la misma clave devuelve la anulación original', async () => {
    const m = await org.newMembership();
    const e = await earn(h.db, org.orgId, { membershipId: m, operator: org.owner, idempotencyKey: key() });
    const k = key();
    const input = {
      entryId: e.entries[0]!.id,
      reason: 'Error de caja',
      operator: org.owner,
      idempotencyKey: k,
    };
    const v1 = await voidEntry(h.db, org.orgId, input);
    const v2 = await voidEntry(h.db, org.orgId, input);
    expect(v2.replayed).toBe(true);
    expect(v2.entries[0]!.id).toBe(v1.entries[0]!.id);
    expect(await codeOf(voidEntry(h.db, org.orgId, { ...input, idempotencyKey: key() }))).toBe(
      'already_voided',
    );
  });

  it('el trabajador solo anula su último movimiento, propio y dentro de 15 minutos', async () => {
    const org = await createTestOrg(h.db, { mode: 'stamps', goal: 10 });
    const m = await org.newMembership();
    const mine1 = await earn(h.db, org.orgId, {
      membershipId: m,
      operator: org.staff,
      idempotencyKey: key(),
      now: at(0),
    });
    const mine2 = await earn(h.db, org.orgId, {
      membershipId: m,
      operator: org.staff,
      idempotencyKey: key(),
      now: at(1),
    });
    const theirs = await earn(h.db, org.orgId, {
      membershipId: m,
      operator: org.staff2,
      idempotencyKey: key(),
      now: at(2),
    });
    const v = (entryId: string, now: Date) =>
      voidEntry(h.db, org.orgId, {
        entryId,
        reason: 'Error de caja',
        operator: org.staff,
        idempotencyKey: key(),
        now,
      });
    expect(await codeOf(v(theirs.entries[0]!.id, at(2)))).toBe('void_not_own');
    expect(await codeOf(v(mine1.entries[0]!.id, at(1)))).toBe('void_not_latest');
    expect(await codeOf(v(mine2.entries[0]!.id, new Date(at(1).getTime() + 16 * 60_000)))).toBe(
      'void_window_expired',
    );
    expect(await codeOf(v(mine2.entries[0]!.id, new Date(at(1).getTime() + 5 * 60_000)))).toBe('ok');
  });

  it('las conversiones y reversas no se anulan directamente', async () => {
    const m = await org.newMembership();
    const r = await adjust(h.db, org.orgId, {
      membershipId: m,
      delta: 3,
      reason: 'Tarjeta física',
      operator: org.owner,
      idempotencyKey: key(),
    });
    const convert = r.entries.find((e) => e.kind === 'convert')!;
    expect(
      await codeOf(
        voidEntry(h.db, org.orgId, {
          entryId: convert.id,
          reason: 'Error',
          operator: org.owner,
          idempotencyKey: key(),
        }),
      ),
    ).toBe('not_voidable');
  });

  it('anular el canje de un premio ganado lo deja disponible otra vez', async () => {
    const m = await org.newMembership();
    const g = await adjust(h.db, org.orgId, {
      membershipId: m,
      delta: 3,
      reason: 'Tarjeta física',
      operator: org.owner,
      idempotencyKey: key(),
    });
    const r = await redeem(h.db, org.orgId, {
      membershipId: m,
      earnedRewardId: g.earnedRewards[0]!.id,
      operator: org.staff,
      idempotencyKey: key(),
    });
    const k = key();
    const v = await voidRedemption(h.db, org.orgId, {
      redemptionId: r.redemption!.id,
      reason: 'Se canjeó por error',
      operator: org.staff,
      idempotencyKey: k,
    });
    expect(v.membership.availableRewards).toHaveLength(1);
    expect(
      (
        await voidRedemption(h.db, org.orgId, {
          redemptionId: r.redemption!.id,
          reason: 'Se canjeó por error',
          operator: org.staff,
          idempotencyKey: k,
        })
      ).replayed,
    ).toBe(true);
    expect(
      await codeOf(
        voidRedemption(h.db, org.orgId, {
          redemptionId: r.redemption!.id,
          reason: 'Otra vez',
          operator: org.staff,
          idempotencyKey: key(),
        }),
      ),
    ).toBe('already_voided');
  });
});

describe('límites anti-fraude', () => {
  let org: TestOrg;
  beforeAll(async () => {
    org = await createTestOrg(h.db, {
      mode: 'stamps',
      goal: 10,
      limits: { cooldown_minutes: 240, staff_daily_units: 2 },
    });
  });

  it('cooldown: una segunda suma antes de 4 h se rechaza e indica cuándo reintentar', async () => {
    const m = await org.newMembership();
    await earn(h.db, org.orgId, { membershipId: m, operator: org.staff, idempotencyKey: key(), now: at(0) });
    try {
      await earn(h.db, org.orgId, {
        membershipId: m,
        operator: org.staff,
        idempotencyKey: key(),
        now: at(1),
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(LoyaltyError);
      expect((e as LoyaltyError).code).toBe('cooldown_active');
      expect((e as LoyaltyError).details).toMatchObject({ overridable: false });
    }
    expect(
      await codeOf(
        earn(h.db, org.orgId, { membershipId: m, operator: org.staff, idempotencyKey: key(), now: at(5) }),
      ),
    ).toBe('ok');
  });

  it('una suma anulada no cuenta para el cooldown', async () => {
    const m = await org.newMembership();
    const e = await earn(h.db, org.orgId, {
      membershipId: m,
      operator: org.owner,
      idempotencyKey: key(),
      now: at(0),
    });
    await voidEntry(h.db, org.orgId, {
      entryId: e.entries[0]!.id,
      reason: 'Cliente equivocado',
      operator: org.owner,
      idempotencyKey: key(),
      now: at(0),
    });
    expect(
      await codeOf(
        earn(h.db, org.orgId, { membershipId: m, operator: org.owner, idempotencyKey: key(), now: at(0.5) }),
      ),
    ).toBe('ok');
  });

  it('el dueño puede superar un límite con motivo (queda auditado); el trabajador no', async () => {
    const m = await org.newMembership();
    await earn(h.db, org.orgId, { membershipId: m, operator: org.owner, idempotencyKey: key(), now: at(0) });
    expect(
      await codeOf(
        earn(h.db, org.orgId, {
          membershipId: m,
          operator: org.staff,
          overrideReason: 'Lo digo yo',
          idempotencyKey: key(),
          now: at(1),
        }),
      ),
    ).toBe('cooldown_active');
    const r = await earn(h.db, org.orgId, {
      membershipId: m,
      operator: org.owner,
      overrideReason: 'Dos servicios hoy',
      idempotencyKey: key(),
      now: at(1),
    });
    expect(r.overriddenLimits).toEqual(['cooldown_active']);
    const [log] = await withSystemTx(h.db, (tx) =>
      tx
        .select()
        .from(schema.auditLogs)
        .where(
          and(
            eq(schema.auditLogs.action, 'limits.overridden'),
            eq(schema.auditLogs.entityId, r.entries[0]!.id),
          ),
        ),
    );
    expect(log?.after).toMatchObject({ reason: 'Dos servicios hoy', violations: ['cooldown_active'] });
  });

  it('tope diario por trabajador (no aplica a dueño/admin)', async () => {
    const worker = { ...org.staff2 };
    for (let i = 0; i < 2; i++)
      await earn(h.db, org.orgId, {
        membershipId: await org.newMembership(),
        operator: worker,
        idempotencyKey: key(),
        now: at(30),
      });
    expect(
      await codeOf(
        earn(h.db, org.orgId, {
          membershipId: await org.newMembership(),
          operator: worker,
          idempotencyKey: key(),
          now: at(30),
        }),
      ),
    ).toBe('staff_daily_units');
    for (let i = 0; i < 3; i++)
      expect(
        await codeOf(
          earn(h.db, org.orgId, {
            membershipId: await org.newMembership(),
            operator: org.owner,
            idempotencyKey: key(),
            now: at(30),
          }),
        ),
      ).toBe('ok');
  });
});

describe('bono de bienvenida y versiones de regla', () => {
  it('el bono se da en la primera visita validada, no al registrarse, y se revierte si esa visita se anula', async () => {
    const org = await createTestOrg(h.db, {
      mode: 'stamps',
      goal: 10,
      welcomeBonus: { type: 'units', units: 2 },
    });
    const m = await org.newMembership();
    expect((await ledgerSum(m)).balance).toBe(0); // registrarse no da nada
    const first = await earn(h.db, org.orgId, {
      membershipId: m,
      operator: org.owner,
      idempotencyKey: key(),
    });
    expect(first.entries.map((e) => [e.kind, e.delta])).toEqual([
      ['earn', 1],
      ['bonus', 2],
    ]);
    expect(first.membership.balance).toBe(3);
    expect(first.membership.firstValidatedAt).not.toBeNull();
    const second = await earn(h.db, org.orgId, {
      membershipId: m,
      operator: org.owner,
      idempotencyKey: key(),
    });
    expect(second.entries.map((e) => e.kind)).toEqual(['earn']);

    const v1 = await voidEntry(h.db, org.orgId, {
      entryId: second.entries[0]!.id,
      reason: 'Error',
      operator: org.owner,
      idempotencyKey: key(),
    });
    expect(v1.membership.balance).toBe(3);
    const v2 = await voidEntry(h.db, org.orgId, {
      entryId: first.entries[0]!.id,
      reason: 'Error',
      operator: org.owner,
      idempotencyKey: key(),
    });
    expect(v2.membership.balance).toBe(0);
    expect(v2.membership.firstValidatedAt).toBeNull();
    const again = await earn(h.db, org.orgId, {
      membershipId: m,
      operator: org.owner,
      idempotencyKey: key(),
    });
    expect(again.membership.balance).toBe(3);
  });

  it('bono de regalo: la primera visita genera un premio de bienvenida', async () => {
    const org = await createTestOrg(h.db, { mode: 'points' });
    await createRuleVersion(h.db, org.orgId, org.owner, {
      earnRule: { type: 'per_amount', amount_per_unit: 1 },
      goal: null,
      welcomeBonus: { type: 'reward', reward_id: org.giftRewardId },
    });
    const m = await org.newMembership();
    const r = await earn(h.db, org.orgId, {
      membershipId: m,
      amount: 10,
      operator: org.owner,
      idempotencyKey: key(),
    });
    expect(r.earnedRewards).toEqual([
      expect.objectContaining({ source: 'welcome', rewardId: org.giftRewardId }),
    ]);
  });

  it('una regla nueva aplica a lo que viene; lo anterior conserva su versión', async () => {
    const org = await createTestOrg(h.db, { mode: 'points' });
    const m = await org.newMembership();
    const before = await earn(h.db, org.orgId, {
      membershipId: m,
      amount: 10,
      operator: org.owner,
      idempotencyKey: key(),
    });
    const v2 = await createRuleVersion(h.db, org.orgId, org.owner, {
      earnRule: { type: 'per_amount', amount_per_unit: 2 },
      goal: null,
    });
    expect(v2.version).toBe(2);
    const after = await earn(h.db, org.orgId, {
      membershipId: m,
      amount: 10,
      operator: org.owner,
      idempotencyKey: key(),
    });
    expect([before.entries[0]!.delta, after.entries[0]!.delta]).toEqual([10, 5]);
    const rows = await withSystemTx(h.db, (tx) =>
      tx
        .select({ v: schema.ledgerEntries.ruleVersionId })
        .from(schema.ledgerEntries)
        .where(eq(schema.ledgerEntries.membershipId, m))
        .orderBy(schema.ledgerEntries.createdAt),
    );
    expect(rows.map((r) => r.v)).toEqual([org.ruleVersionId, v2.id]);
    const p = await getProgram(h.db, org.orgId);
    expect(p.rule?.version).toBe(2);
  });

  it('valida reglas y premios según el modo del programa', async () => {
    const stamps = await createTestOrg(h.db, { mode: 'stamps' });
    expect(
      await codeOf(
        createRuleVersion(h.db, stamps.orgId, stamps.owner, {
          earnRule: { type: 'per_visit', units: 1 },
          goal: null,
        }),
      ),
    ).toBe('invalid_rule');
    expect(
      await codeOf(createReward(h.db, stamps.orgId, stamps.owner, { kind: 'catalog', name: 'X', cost: 10 })),
    ).toBe('invalid_rule');
    expect(
      await codeOf(
        createReward(h.db, stamps.orgId, stamps.owner, { kind: 'goal', name: 'Otro premio de meta' }),
      ),
    ).toBe('invalid_rule');
    const points = await createTestOrg(h.db, { mode: 'points' });
    expect(
      await codeOf(createReward(h.db, points.orgId, points.owner, { kind: 'catalog', name: 'Sin costo' })),
    ).toBe('invalid_rule');
    expect(
      await codeOf(
        createReward(h.db, points.orgId, points.owner, { kind: 'catalog', name: 'Brownie', cost: 40 }),
      ),
    ).toBe('ok');
  });
});

describe('expiración por inactividad', () => {
  it('vence el saldo tras N meses sin actividad, una sola vez', async () => {
    const org = await createTestOrg(h.db, { mode: 'points', expirationMonths: 12 });
    const m = await org.newMembership();
    const active = await org.newMembership();
    await earn(h.db, org.orgId, {
      membershipId: m,
      amount: 40,
      operator: org.owner,
      idempotencyKey: key(),
      now: new Date('2025-01-10T15:00:00Z'),
    });
    await earn(h.db, org.orgId, {
      membershipId: active,
      amount: 40,
      operator: org.owner,
      idempotencyKey: key(),
      now: new Date('2025-11-10T15:00:00Z'),
    });
    const now = new Date('2026-02-01T08:00:00Z');
    expect((await expireInactive(h.db, org.orgId, now)).expiredMemberships).toBe(1);
    expect((await expireInactive(h.db, org.orgId, now)).expiredMemberships).toBe(0);
    expect(await ledgerSum(m)).toMatchObject({ balance: 0, sum: 0 });
    expect((await ledgerSum(active)).balance).toBe(40);
  });

  it('sin expiración configurada (piloto) no hace nada', async () => {
    const org = await createTestOrg(h.db, { mode: 'points' });
    const m = await org.newMembership();
    await earn(h.db, org.orgId, {
      membershipId: m,
      amount: 40,
      operator: org.owner,
      idempotencyKey: key(),
      now: new Date('2020-01-01T00:00:00Z'),
    });
    expect((await expireInactive(h.db, org.orgId)).expiredMemberships).toBe(0);
  });
});

describe('concurrencia', () => {
  it('20 sumas simultáneas al mismo cliente: saldo exacto, sin duplicados ni pérdidas', async () => {
    const org = await createTestOrg(h.db, { mode: 'points' });
    const m = await org.newMembership();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        earn(h.db, org.orgId, { membershipId: m, amount: 10, operator: org.staff, idempotencyKey: key() }),
      ),
    );
    expect(results.every((r) => !r.replayed)).toBe(true);
    expect(await ledgerSum(m)).toMatchObject({ balance: 200, sum: 200 });
    const afters = results.map((r) => r.entries[0]!.balanceAfter).sort((a, b) => a - b);
    expect(afters).toEqual(Array.from({ length: 20 }, (_, i) => (i + 1) * 10));
  });

  it('20 sumas simultáneas con cooldown: solo 1 pasa (la membresía se bloquea mientras se decide)', async () => {
    const org = await createTestOrg(h.db, { mode: 'stamps', limits: { cooldown_minutes: 240 } });
    const m = await org.newMembership();
    const codes = await Promise.all(
      Array.from({ length: 20 }, () =>
        codeOf(earn(h.db, org.orgId, { membershipId: m, operator: org.staff, idempotencyKey: key() })),
      ),
    );
    expect(codes.filter((c) => c === 'ok')).toHaveLength(1);
    expect(codes.filter((c) => c === 'cooldown_active')).toHaveLength(19);
  });

  it('10 reintentos simultáneos con la misma clave: 1 movimiento', async () => {
    const org = await createTestOrg(h.db, { mode: 'points' });
    const m = await org.newMembership();
    const k = key();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        earn(h.db, org.orgId, { membershipId: m, amount: 10, operator: org.staff, idempotencyKey: k }),
      ),
    );
    expect(new Set(results.map((r) => r.entries[0]!.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect((await ledgerSum(m)).balance).toBe(10);
  });

  it('dos canjes simultáneos del mismo premio: solo 1 pasa', async () => {
    const org = await createTestOrg(h.db, { mode: 'stamps', goal: 1 });
    const m = await org.newMembership();
    const g = await earn(h.db, org.orgId, { membershipId: m, operator: org.owner, idempotencyKey: key() });
    const earnedRewardId = g.earnedRewards[0]!.id;
    const codes = await Promise.all(
      Array.from({ length: 5 }, () =>
        codeOf(
          redeem(h.db, org.orgId, {
            membershipId: m,
            earnedRewardId,
            operator: org.staff,
            idempotencyKey: key(),
          }),
        ),
      ),
    );
    expect(codes.filter((c) => c === 'ok')).toHaveLength(1);
  });

  it('dos anulaciones simultáneas del mismo movimiento: solo 1 pasa', async () => {
    const org = await createTestOrg(h.db, { mode: 'points' });
    const m = await org.newMembership();
    const e = await earn(h.db, org.orgId, {
      membershipId: m,
      amount: 30,
      operator: org.owner,
      idempotencyKey: key(),
    });
    const codes = await Promise.all(
      Array.from({ length: 5 }, () =>
        codeOf(
          voidEntry(h.db, org.orgId, {
            entryId: e.entries[0]!.id,
            reason: 'Duplicado',
            operator: org.owner,
            idempotencyKey: key(),
          }),
        ),
      ),
    );
    expect(codes.filter((c) => c === 'ok')).toHaveLength(1);
    expect(codes.filter((c) => c === 'already_voided')).toHaveLength(4);
    expect((await ledgerSum(m)).balance).toBe(0);
  });
});

describe('aislamiento y estado', () => {
  it('no se puede operar una membresía de otro negocio (aunque se conozca su id)', async () => {
    const org = await createTestOrg(h.db, { mode: 'points' });
    const foreign = seedMembershipId('barberia', 2);
    expect(
      await codeOf(
        earn(h.db, org.orgId, {
          membershipId: foreign,
          amount: 10,
          operator: org.owner,
          idempotencyKey: key(),
        }),
      ),
    ).toBe('not_found');
    expect(
      await codeOf(
        adjust(h.db, org.orgId, {
          membershipId: foreign,
          delta: 5,
          reason: 'Intento cruzado',
          operator: org.owner,
          idempotencyKey: key(),
        }),
      ),
    ).toBe('not_found');
    const [entry] = await withSystemTx(h.db, (tx) =>
      tx
        .select({ id: schema.ledgerEntries.id })
        .from(schema.ledgerEntries)
        .where(eq(schema.ledgerEntries.organizationId, SEED.orgs.barberia.id))
        .limit(1),
    );
    expect(
      await codeOf(
        voidEntry(h.db, org.orgId, {
          entryId: entry!.id,
          reason: 'Intento cruzado',
          operator: org.owner,
          idempotencyKey: key(),
        }),
      ),
    ).toBe('not_found');
  });

  it('una membresía bloqueada no suma ni canjea', async () => {
    const org = await createTestOrg(h.db, { mode: 'points' });
    const m = await org.newMembership();
    await withSystemTx(h.db, (tx) =>
      tx.update(schema.memberships).set({ status: 'blocked' }).where(eq(schema.memberships.id, m)),
    );
    expect(
      await codeOf(
        earn(h.db, org.orgId, { membershipId: m, amount: 10, operator: org.owner, idempotencyKey: key() }),
      ),
    ).toBe('membership_inactive');
  });

  it('los ajustes exigen motivo y no dejan saldo negativo', async () => {
    const org = await createTestOrg(h.db, { mode: 'points' });
    const m = await org.newMembership();
    expect(
      await codeOf(
        adjust(h.db, org.orgId, {
          membershipId: m,
          delta: 5,
          reason: '',
          operator: org.owner,
          idempotencyKey: key(),
        }),
      ),
    ).toBe('reason_required');
    expect(
      await codeOf(
        adjust(h.db, org.orgId, {
          membershipId: m,
          delta: -1,
          reason: 'Corrección',
          operator: org.owner,
          idempotencyKey: key(),
        }),
      ),
    ).toBe('balance_would_be_negative');
    const ok = await adjust(h.db, org.orgId, {
      membershipId: m,
      delta: 5,
      reason: 'Compensación por demora',
      operator: org.owner,
      idempotencyKey: key(),
    });
    const [log] = await withSystemTx(h.db, (tx) =>
      tx
        .select()
        .from(schema.auditLogs)
        .where(
          and(
            eq(schema.auditLogs.action, 'ledger.adjusted'),
            eq(schema.auditLogs.entityId, ok.entries[0]!.id),
          ),
        ),
    );
    expect(log?.after).toMatchObject({ delta: 5, balanceBefore: 0, balanceAfter: 5 });
  });
});
