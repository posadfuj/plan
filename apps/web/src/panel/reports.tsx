/**
 * Reportes (semana 6): altas por canal, visitas, clientes que volvieron, premios y actividad por
 * persona, en 7, 30 o 90 días. Solo números: el reporte no trae datos personales.
 * Exportación CSV de clientes y movimientos (queda registrada en la auditoría).
 */
import { useCallback, useEffect, useState } from 'react';
import { Alert, Spinner } from '../components/ui';
import { Card, downloadFile, errorText, SmallButton, useAction, usePanel } from './shared';

type Channel = 'qr' | 'nfc' | 'direct' | 'unknown';
interface Report {
  period: { days: number; from: string; to: string; timezone: string };
  customers: { total: number; blocked: number };
  signups: { total: number; byChannel: Record<Channel, number> };
  scans: { total: number; converted: number; byChannel: Record<Channel, number> };
  visits: {
    total: number;
    customers: number;
    returningCustomers: number;
    byDay: { day: string; visits: number }[];
  };
  rewards: { earned: number; earnedGoal: number; earnedWelcome: number; redeemed: number };
  staff: {
    id: string;
    name: string;
    role: 'owner' | 'admin' | 'staff';
    visits: number;
    voids: number;
    overrides: number;
    approvals: number;
    redemptions: number;
    failedPins: number;
  }[];
}

const PERIODS = [7, 30, 90] as const;
const CHANNEL_LABEL: Record<Channel, string> = {
  qr: 'QR',
  nfc: 'NFC',
  direct: 'Enlace directo',
  unknown: 'Sin dato',
};
const ROLE_LABEL = { owner: 'Dueño', admin: 'Admin', staff: 'Caja' } as const;

function Stat({
  label,
  value,
  hint,
  testId,
}: {
  label: string;
  value: number;
  hint?: string;
  testId?: string;
}) {
  return (
    <div className="rounded-xl bg-gray-50 p-3" data-testid={testId}>
      <p className="text-xs font-medium text-gray-600">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value.toLocaleString('es-PE')}</p>
      {hint && <p className="text-xs text-gray-500">{hint}</p>}
    </div>
  );
}

/** Días del período (aunque no haya visitas), en la zona horaria del negocio. */
function periodDays(r: Report): string[] {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: r.period.timezone });
  const out: string[] = [];
  for (let i = r.period.days - 1; i >= 0; i--)
    out.push(fmt.format(new Date(Date.parse(r.period.to) - i * 86_400_000)));
  return [...new Set(out)].slice(-r.period.days);
}

/** Barras finas de una sola serie: visitas por día. Tooltip por barra y tabla accesible. */
function VisitsChart({ report }: { report: Report }) {
  const byDay = new Map(report.visits.byDay.map((d) => [d.day, d.visits]));
  const days = periodDays(report).map((day) => ({ day, visits: byDay.get(day) ?? 0 }));
  const max = Math.max(1, ...days.map((d) => d.visits));
  const label = (day: string) =>
    new Date(`${day}T12:00:00Z`).toLocaleDateString('es-PE', {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    });
  return (
    <figure>
      <div className="flex h-32 items-end gap-[2px] border-b border-gray-200" aria-hidden>
        {days.map((d) => (
          <div
            key={d.day}
            className="group relative flex h-full flex-1 items-end"
            title={`${label(d.day)}: ${d.visits}`}
          >
            <div
              className="w-full rounded-t-[4px] bg-gray-800 group-hover:bg-gray-600"
              style={{ height: `${(d.visits / max) * 100}%`, minHeight: d.visits ? 2 : 0 }}
            />
          </div>
        ))}
      </div>
      <figcaption className="mt-1 flex justify-between text-xs text-gray-500">
        <span>{label(days[0]!.day)}</span>
        <span>Máximo: {max} por día</span>
        <span>{label(days.at(-1)!.day)}</span>
      </figcaption>
      <table className="sr-only">
        <caption>Visitas por día</caption>
        <tbody>
          {days.map((d) => (
            <tr key={d.day}>
              <th scope="row">{label(d.day)}</th>
              <td>{d.visits}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

export function ReportsSection() {
  const { call, orgId, token } = usePanel();
  const [days, setDays] = useState<(typeof PERIODS)[number]>(30);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { msg, busy, run } = useAction();

  const load = useCallback(async () => {
    setError(null);
    try {
      setReport(await call<Report>(`/reports?days=${days}`));
    } catch (e) {
      setError(errorText(e));
    }
  }, [call, days]);
  useEffect(() => void load(), [load]);

  const download = (path: string, name: string) =>
    run(() => downloadFile(`/v1/orgs/${orgId}${path}`, token, name), 'Descarga lista.');

  return (
    <div className="space-y-4" data-testid="reports">
      <div className="flex gap-1" role="group" aria-label="Período">
        {PERIODS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setDays(p)}
            aria-pressed={days === p}
            className={`min-h-11 flex-1 rounded-xl px-3 text-sm font-semibold ${
              days === p ? 'bg-gray-900 text-white' : 'bg-white ring-1 ring-gray-300'
            }`}
          >
            {p} días
          </button>
        ))}
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      {!report && !error && <Spinner />}
      {report && (
        <>
          <Card title="Clientes">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Nuevos" value={report.signups.total} testId="stat-signups" />
              <Stat label="Vinieron" value={report.visits.customers} hint="con al menos 1 visita" />
              <Stat
                label="Volvieron"
                value={report.visits.returningCustomers}
                hint="2 o más visitas"
                testId="stat-returning"
              />
              <Stat
                label="Total"
                value={report.customers.total}
                hint={`${report.customers.blocked} bloqueados`}
              />
            </div>
            <h3 className="mt-4 text-sm font-semibold">Altas por canal</h3>
            <ul className="mt-1 divide-y divide-gray-100 text-sm" data-testid="signups-by-channel">
              {(['qr', 'nfc', 'direct', 'unknown'] as const)
                .filter((ch) => ch !== 'unknown' || report.signups.byChannel.unknown > 0)
                .map((ch) => (
                  <li key={ch} className="flex justify-between py-2">
                    <span>
                      {CHANNEL_LABEL[ch]}
                      {ch !== 'direct' && ch !== 'unknown' && (
                        <span className="text-gray-500"> · {report.scans.byChannel[ch]} escaneos</span>
                      )}
                    </span>
                    <strong className="tabular-nums">{report.signups.byChannel[ch]}</strong>
                  </li>
                ))}
            </ul>
          </Card>

          <Card title="Visitas por día">
            <p className="mb-3 text-sm text-gray-600" data-testid="stat-visits">
              <strong className="text-lg text-gray-900">{report.visits.total}</strong> visitas en{' '}
              {report.period.days} días (las anuladas no cuentan)
            </p>
            <VisitsChart report={report} />
          </Card>

          <Card title="Premios">
            <div className="grid grid-cols-2 gap-2">
              <Stat
                label="Ganados"
                value={report.rewards.earned}
                hint={
                  report.rewards.earnedWelcome ? `${report.rewards.earnedWelcome} de bienvenida` : undefined
                }
                testId="stat-earned"
              />
              <Stat label="Canjeados" value={report.rewards.redeemed} testId="stat-redeemed" />
            </div>
          </Card>

          <Card title="Actividad por persona">
            <p className="mb-2 text-xs text-gray-600">
              Muchas anulaciones o excepciones seguidas, o PIN del dueño equivocados, merecen una revisión.
            </p>
            <div className="-mx-4 overflow-x-auto px-4">
              <table className="w-full min-w-[34rem] text-sm" data-testid="staff-activity">
                <thead className="text-left text-xs text-gray-500">
                  <tr>
                    <th className="py-2 pr-2 font-medium">Persona</th>
                    <th className="px-2 text-right font-medium">Visitas</th>
                    <th className="px-2 text-right font-medium">Anulaciones</th>
                    <th className="px-2 text-right font-medium">Excepciones</th>
                    <th className="px-2 text-right font-medium">Autorizó</th>
                    <th className="px-2 text-right font-medium">Canjes</th>
                    <th className="pl-2 text-right font-medium">PIN dueño errado</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {report.staff.map((s) => (
                    <tr key={s.id}>
                      <td className="py-2 pr-2">
                        {s.name} <span className="text-xs text-gray-500">· {ROLE_LABEL[s.role]}</span>
                      </td>
                      <td className="px-2 text-right tabular-nums">{s.visits}</td>
                      <td className="px-2 text-right tabular-nums">{s.voids}</td>
                      <td className="px-2 text-right tabular-nums">{s.overrides}</td>
                      <td className="px-2 text-right tabular-nums">{s.approvals}</td>
                      <td className="px-2 text-right tabular-nums">{s.redemptions}</td>
                      <td
                        className={`pl-2 text-right tabular-nums ${s.failedPins ? 'font-bold text-red-700' : ''}`}
                      >
                        {s.failedPins}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      <Card title="Exportar a Excel (CSV)" testId="exports">
        {msg && (
          <div className="mb-3">
            <Alert tone={msg.tone}>{msg.text}</Alert>
          </div>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          <SmallButton
            disabled={busy}
            onClick={() => void download('/exports/customers.csv', 'clientes.csv')}
            data-testid="export-customers"
          >
            Clientes (con datos de contacto)
          </SmallButton>
          <SmallButton
            disabled={busy}
            onClick={() => void download(`/exports/movements.csv?days=${days}`, 'movimientos.csv')}
            data-testid="export-movements"
          >
            Movimientos de los últimos {days} días
          </SmallButton>
        </div>
        <p className="mt-2 text-xs text-gray-600">
          Cada descarga queda registrada. Escribe con fines comerciales solo a quienes figuran con “Acepta
          promociones: Sí”.
        </p>
      </Card>
    </div>
  );
}
