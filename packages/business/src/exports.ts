/**
 * Exportación CSV (semana 6): solo dueño y admin, siempre auditada (sin datos personales en la
 * auditoría: tipo de exportación, filas y período).
 *
 * - Clientes: datos de contacto, saldo, visitas y si ACEPTÓ PROMOCIONES (solo a esos se les puede
 *   escribir con fines comerciales, Ley 29733).
 * - Movimientos del período: con el código de la tarjeta, sin nombre ni celular.
 *
 * Seguridad: un texto que empieza con = + - @ (o tab/CR) se antepone con ' para que Excel no lo
 * ejecute como fórmula (inyección CSV). UTF-8 con BOM para que Excel muestre bien tildes y ñ.
 */
import { schema, withTenantTx, type Db, type Tx } from '@aiment/db';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { BusinessError, type Editor } from './errors';
import { REPORT_PERIODS } from './reports';

const { organizations, plans, orgFeatureOverrides, auditLogs } = schema;

/** Celda de texto segura para Excel/Sheets. */
export function csvText(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  let v = String(value);
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * Celular legible y que Excel no tome como fórmula ni como número: los de Perú en formato nacional
 * ("987 654 321"); los demás quedan en E.164 protegidos por csvText.
 */
export function csvPhone(e164: string | null): string {
  if (!e164) return '';
  const pe = /^\+51(9\d{2})(\d{3})(\d{3})$/.exec(e164);
  return pe ? `${pe[1]} ${pe[2]} ${pe[3]}` : csvText(e164);
}

const csvNumber = (n: number | string | null | undefined) =>
  n === null || n === undefined || n === '' ? '' : String(Number(n));

export function toCsv(header: string[], rows: string[][]): string {
  return '\uFEFF' + [header.map(csvText), ...rows].map((r) => r.join(',')).join('\r\n') + '\r\n';
}

async function assertCsvAllowed(tx: Tx, orgId: string) {
  const [override] = await tx
    .select({ value: orgFeatureOverrides.value })
    .from(orgFeatureOverrides)
    .where(and(eq(orgFeatureOverrides.organizationId, orgId), eq(orgFeatureOverrides.feature, 'csv')));
  const [plan] = await tx
    .select({ features: plans.features, slug: organizations.slug, timezone: organizations.timezone })
    .from(organizations)
    .innerJoin(plans, eq(plans.code, organizations.planCode))
    .where(eq(organizations.id, orgId));
  if (!plan) throw new BusinessError(404, 'not_found', 'Recurso no encontrado');
  const allowed = override ? override.value === true : (plan.features as { csv?: unknown }).csv === true;
  if (!allowed)
    throw new BusinessError(
      409,
      'plan_feature',
      'La exportación CSV no está incluida en tu plan. Para activarla, pide a Aiment el cambio de plan.',
    );
  return { slug: plan.slug, timezone: plan.timezone };
}

const today = (tz: string, now: Date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);

const localDateTime = (d: Date | string | null, tz: string) => {
  if (!d) return '';
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(d))
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
};

export interface CsvFile {
  filename: string;
  csv: string;
  rows: number;
}

async function audit(tx: Tx, orgId: string, editor: Editor, after: Record<string, unknown>) {
  await tx.insert(auditLogs).values({
    organizationId: orgId,
    actorType: editor.actorType,
    actorId: editor.orgUserId,
    action: 'customers.exported',
    entityType: 'organization',
    entityId: orgId,
    after,
  });
}

const STATUS: Record<string, string> = { active: 'Activo', blocked: 'Bloqueado', closed: 'Cerrado' };
const CHANNEL: Record<string, string> = { qr: 'QR', nfc: 'NFC', direct: 'Directo', unknown: 'Sin dato' };

export async function exportCustomersCsv(
  db: Db,
  orgId: string,
  editor: Editor,
  now = new Date(),
): Promise<CsvFile> {
  return withTenantTx(db, orgId, async (tx) => {
    const org = await assertCsvAllowed(tx, orgId);
    const rows = (await tx.execute(sql`
      select c.full_name, c.phone_e164, c.email, c.birth_date::text as birth_date,
        m.short_code, m.status::text as status, m.balance, m.created_at, m.last_activity_at,
        (select count(*)::int from app.ledger_entries e where e.membership_id = m.id and e.kind = 'earn'
          and not exists (select 1 from app.ledger_entries r where r.reverses_entry_id = e.id)) as visits,
        (select count(*)::int from app.earned_rewards er where er.membership_id = m.id and er.status = 'available')
          as available_rewards,
        (select count(*)::int from app.redemptions rd where rd.membership_id = m.id and rd.status = 'completed')
          as redemptions,
        (select cc.granted from app.customer_consents cc join app.consent_versions cv on cv.id = cc.consent_version_id
          where cc.customer_id = c.id and cv.kind = 'marketing' order by cc.created_at desc limit 1) as marketing,
        (select cc.channel::text from app.customer_consents cc join app.consent_versions cv on cv.id = cc.consent_version_id
          where cc.customer_id = c.id and cv.kind = 'terms' order by cc.created_at limit 1) as channel
      from app.customers c join app.memberships m on m.customer_id = c.id
      where c.organization_id = ${orgId} and c.status = 'active'
      order by m.created_at`)) as unknown as {
      full_name: string;
      phone_e164: string;
      email: string | null;
      birth_date: string | null;
      short_code: string;
      status: string;
      balance: number;
      created_at: Date | string;
      last_activity_at: Date | string | null;
      visits: number;
      available_rewards: number;
      redemptions: number;
      marketing: boolean | null;
      channel: string | null;
    }[];
    const csv = toCsv(
      [
        'Nombre',
        'Celular',
        'Correo',
        'Cumpleaños',
        'Código de tarjeta',
        'Estado',
        'Saldo',
        'Visitas',
        'Premios por canjear',
        'Premios canjeados',
        'Acepta promociones',
        'Canal de registro',
        'Cliente desde',
        'Última actividad',
      ],
      rows.map((r) => [
        csvText(r.full_name),
        csvPhone(r.phone_e164),
        csvText(r.email),
        csvText(r.birth_date),
        csvText(r.short_code),
        csvText(STATUS[r.status] ?? r.status),
        csvNumber(r.balance),
        csvNumber(r.visits),
        csvNumber(r.available_rewards),
        csvNumber(r.redemptions),
        r.marketing === true ? 'Sí' : 'No',
        csvText(CHANNEL[r.channel ?? 'unknown'] ?? 'Sin dato'),
        localDateTime(r.created_at, org.timezone),
        localDateTime(r.last_activity_at, org.timezone),
      ]),
    );
    await audit(tx, orgId, editor, { kind: 'customers', rows: rows.length });
    return { filename: `clientes-${org.slug}-${today(org.timezone, now)}.csv`, csv, rows: rows.length };
  });
}

const KIND: Record<string, string> = {
  earn: 'Visita / compra',
  bonus: 'Bono de bienvenida',
  convert: 'Premio ganado (meta)',
  redeem: 'Canje',
  adjust: 'Ajuste',
  expire: 'Vencimiento',
  reversal: 'Anulación',
};

export const movementsQuery = z.object({
  days: z.coerce
    .number()
    .refine((d) => (REPORT_PERIODS as readonly number[]).includes(d), {
      message: 'El período debe ser 7, 30 o 90 días',
    })
    .default(30),
});

export async function exportMovementsCsv(
  db: Db,
  orgId: string,
  editor: Editor,
  raw: unknown,
  now = new Date(),
): Promise<CsvFile> {
  const { days } = movementsQuery.parse(raw ?? {});
  return withTenantTx(db, orgId, async (tx) => {
    const org = await assertCsvAllowed(tx, orgId);
    const rows = (await tx.execute(sql`
      select e.created_at, e.kind::text as kind, e.delta, e.balance_after, e.amount_money::text as amount,
        e.reason, m.short_code, b.name as branch, u.display_name as actor, e.actor_type::text as actor_type,
        d.name as device
      from app.ledger_entries e
      join app.memberships m on m.id = e.membership_id
      left join app.branches b on b.id = e.branch_id
      left join app.organization_users u on u.id = e.actor_id
      left join app.worker_devices d on d.id = e.device_id
      where e.organization_id = ${orgId}
        and e.created_at >= (date_trunc('day', ${now.toISOString()}::timestamptz at time zone ${org.timezone})
          - make_interval(days => ${days - 1})) at time zone ${org.timezone}
      order by e.created_at, e.idempotency_key`)) as unknown as {
      created_at: Date | string;
      kind: string;
      delta: number;
      balance_after: number;
      amount: string | null;
      reason: string | null;
      short_code: string;
      branch: string | null;
      actor: string | null;
      actor_type: string;
      device: string | null;
    }[];
    const csv = toCsv(
      [
        'Fecha y hora',
        'Tipo',
        'Unidades',
        'Saldo después',
        'Importe (S/)',
        'Código de tarjeta',
        'Sucursal',
        'Atendió',
        'Caja',
        'Motivo',
      ],
      rows.map((r) => [
        localDateTime(r.created_at, org.timezone),
        csvText(KIND[r.kind] ?? r.kind),
        csvNumber(r.delta),
        csvNumber(r.balance_after),
        r.amount ?? '',
        csvText(r.short_code),
        csvText(r.branch),
        csvText(r.actor ?? (r.actor_type === 'system' ? 'Automático' : '')),
        csvText(r.device),
        csvText(r.reason),
      ]),
    );
    await audit(tx, orgId, editor, { kind: 'movements', rows: rows.length, days });
    return {
      filename: `movimientos-${org.slug}-${days}d-${today(org.timezone, now)}.csv`,
      csv,
      rows: rows.length,
    };
  });
}
