/**
 * Reportes del panel (semana 6). Solo números agregados: ningún dato personal.
 *
 * - Altas por canal (QR, NFC, directo): el canal queda en el consentimiento de términos del registro.
 * - Escaneos del QR/NFC del local y cuántos terminaron en registro.
 * - Visitas (sumas no anuladas), clientes que vinieron y clientes que volvieron (2+ visitas).
 * - Premios ganados y canjeados.
 * - Actividad por trabajador: visitas, anulaciones, excepciones de límites (pedidas y autorizadas),
 *   canjes y PIN del dueño equivocados. Sirve para detectar anomalías en caja.
 *
 * El período se cuenta en días completos de la zona horaria del negocio (hoy incluido).
 */
import { withTenantTx, type Db, type Tx } from '@aiment/db';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

export const REPORT_PERIODS = [7, 30, 90] as const;
export const reportQuery = z.object({
  days: z.coerce
    .number()
    .refine((d): d is (typeof REPORT_PERIODS)[number] => (REPORT_PERIODS as readonly number[]).includes(d), {
      message: 'El período debe ser 7, 30 o 90 días',
    })
    .default(30),
});

const CHANNELS = ['qr', 'nfc', 'direct', 'unknown'] as const;
type Channel = (typeof CHANNELS)[number];

/** Inicio del período: medianoche local de hace `days - 1` días. */
async function periodStart(tx: Tx, orgId: string, days: number, now: Date) {
  const [r] = (await tx.execute(sql`
    select tz.timezone,
      ((date_trunc('day', ${now.toISOString()}::timestamptz at time zone tz.timezone)
        - make_interval(days => ${days - 1})) at time zone tz.timezone) as "from"
    from (select timezone from app.organizations where id = ${orgId}) tz`)) as unknown as {
    timezone: string;
    from: Date | string;
  }[];
  if (!r) throw new Error('organization_not_found');
  return { timezone: r.timezone, from: new Date(r.from) };
}

const notReversed = sql`not exists (select 1 from app.ledger_entries r where r.reverses_entry_id = e.id)`;

export async function getReport(db: Db, orgId: string, raw: unknown, now = new Date()) {
  const { days } = reportQuery.parse(raw ?? {});
  return withTenantTx(db, orgId, async (tx) => {
    const { timezone, from } = await periodStart(tx, orgId, days, now);
    const since = from.toISOString();
    const rows = async <T>(q: ReturnType<typeof sql>) => (await tx.execute(q)) as unknown as T[];

    const signups = await rows<{ channel: Channel; n: number }>(sql`
      select coalesce(ch.channel::text, 'unknown') as channel, count(*)::int as n
      from app.memberships m
      left join lateral (
        select cc.channel from app.customer_consents cc
        join app.consent_versions cv on cv.id = cc.consent_version_id
        where cc.customer_id = m.customer_id and cv.kind = 'terms'
        order by cc.created_at limit 1
      ) ch on true
      where m.organization_id = ${orgId} and m.created_at >= ${since}::timestamptz
      group by 1`);
    const scans = await rows<{ channel: Channel; scans: number; converted: number }>(sql`
      select channel::text as channel, count(*)::int as scans, count(converted_membership_id)::int as converted
      from app.channel_visits
      where organization_id = ${orgId} and created_at >= ${since}::timestamptz
      group by 1`);

    const [visits] = await rows<{ visits: number; customers: number; returning: number }>(sql`
      with v as (
        select e.membership_id from app.ledger_entries e
        where e.organization_id = ${orgId} and e.kind = 'earn' and e.created_at >= ${since}::timestamptz
          and ${notReversed}
      )
      select count(*)::int as visits,
        count(distinct membership_id)::int as customers,
        (select count(*)::int from (select membership_id from v group by membership_id having count(*) >= 2) x)
          as returning
      from v`);
    const byDay = await rows<{ day: string; n: number }>(sql`
      select to_char(e.created_at at time zone ${timezone}, 'YYYY-MM-DD') as day, count(*)::int as n
      from app.ledger_entries e
      where e.organization_id = ${orgId} and e.kind = 'earn' and e.created_at >= ${since}::timestamptz
        and ${notReversed}
      group by 1 order by 1`);

    const [rewards] = await rows<{ goal: number; welcome: number; redeemed: number }>(sql`
      select
        (select count(*)::int from app.earned_rewards where organization_id = ${orgId}
          and created_at >= ${since}::timestamptz and status <> 'voided' and source = 'goal') as goal,
        (select count(*)::int from app.earned_rewards where organization_id = ${orgId}
          and created_at >= ${since}::timestamptz and status <> 'voided' and source = 'welcome') as welcome,
        (select count(*)::int from app.redemptions where organization_id = ${orgId}
          and created_at >= ${since}::timestamptz and status = 'completed') as redeemed`);

    const [customers] = await rows<{ total: number; blocked: number }>(sql`
      select count(*)::int as total, count(*) filter (where m.status = 'blocked')::int as blocked
      from app.memberships m join app.customers c on c.id = m.customer_id
      where m.organization_id = ${orgId} and c.status = 'active'`);

    const staff = await rows<{
      id: string;
      name: string;
      role: 'owner' | 'admin' | 'staff';
      active: boolean;
      visits: number;
      voids: number;
      overrides: number;
      approvals: number;
      redemptions: number;
      failedPins: number;
    }>(sql`
      with audit as (
        select action, actor_id, after from app.audit_logs
        where organization_id = ${orgId} and created_at >= ${since}::timestamptz
          and action in ('ledger.voided', 'redemption.voided', 'limits.overridden', 'override.pin_failed')
      )
      select u.id, u.display_name as name, u.role, (u.status = 'active') as active,
        (select count(*)::int from app.ledger_entries e where e.organization_id = ${orgId} and e.actor_id = u.id
          and e.kind = 'earn' and e.created_at >= ${since}::timestamptz and ${notReversed}) as visits,
        (select count(*)::int from audit a where a.actor_id = u.id
          and a.action in ('ledger.voided', 'redemption.voided')) as voids,
        (select count(*)::int from audit a where a.actor_id = u.id and a.action = 'limits.overridden') as overrides,
        (select count(*)::int from audit a where a.action = 'limits.overridden'
          and a.after->>'approvedBy' = u.id::text) as approvals,
        (select count(*)::int from app.redemptions r where r.organization_id = ${orgId}
          and r.organization_user_id = u.id and r.status = 'completed'
          and r.created_at >= ${since}::timestamptz) as redemptions,
        (select count(*)::int from audit a where a.actor_id = u.id and a.action = 'override.pin_failed')
          as "failedPins"
      from app.organization_users u
      where u.organization_id = ${orgId}
      order by u.display_name`);

    const byChannel = (list: { channel: Channel }[], pick: (x: never) => number) =>
      Object.fromEntries(
        CHANNELS.map((ch) => [
          ch,
          list.filter((x) => x.channel === ch).reduce((s, x) => s + pick(x as never), 0),
        ]),
      ) as Record<Channel, number>;

    return {
      period: { days, from: from.toISOString(), to: now.toISOString(), timezone },
      customers: { total: customers?.total ?? 0, blocked: customers?.blocked ?? 0 },
      signups: {
        total: signups.reduce((s, x) => s + x.n, 0),
        byChannel: byChannel(signups, (x: { n: number }) => x.n),
      },
      scans: {
        total: scans.reduce((s, x) => s + x.scans, 0),
        converted: scans.reduce((s, x) => s + x.converted, 0),
        byChannel: byChannel(scans, (x: { scans: number }) => x.scans),
      },
      visits: {
        total: visits?.visits ?? 0,
        customers: visits?.customers ?? 0,
        returningCustomers: visits?.returning ?? 0,
        byDay: byDay.map((d) => ({ day: d.day, visits: d.n })),
      },
      rewards: {
        earned: (rewards?.goal ?? 0) + (rewards?.welcome ?? 0),
        earnedGoal: rewards?.goal ?? 0,
        earnedWelcome: rewards?.welcome ?? 0,
        redeemed: rewards?.redeemed ?? 0,
      },
      // Personas activas o con actividad en el período (alguien dado de baja que anuló sigue apareciendo).
      staff: staff
        .filter(
          (s) =>
            s.active || s.visits + s.voids + s.overrides + s.approvals + s.redemptions + s.failedPins > 0,
        )
        .map(({ active: _a, ...s }) => s),
    };
  });
}
