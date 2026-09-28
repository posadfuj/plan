/**
 * /admin — panel maestro de Aiment: alta de negocios (con invitación al dueño), publicación, plan,
 * suspensión, uso agregado y auditoría de plataforma. Nunca muestra datos de clientes.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { Alert, PoweredBy, Spinner } from '../components/ui';
import { LoginForm } from './page';
import {
  Badge,
  Card,
  Field,
  fmtDateTime,
  inputCls,
  SmallButton,
  STATUS_LABEL,
  supabase,
  useAction,
  useSession,
  type Settings,
} from './shared';

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  status: Settings['status'];
  plan: string;
  planName: string;
  limits: { branches?: number; staff?: number };
  branches: number;
  staff: number;
  customers: number;
  movements30d: number;
  owner: string | null;
  createdAt: string;
}
interface Plans {
  plans: { code: string; name: string; limits: { branches?: number; staff?: number } }[];
  templates: { key: string; label: string; mode: string }[];
}
interface AuditRow {
  id: number;
  organization: string | null;
  action: string;
  createdAt: string;
}

const ACTION: Record<string, string> = {
  'org.created': 'Negocio creado',
  'org.owner_invited': 'Invitación reenviada',
  'org.published': 'Publicado',
  'org.plan_changed': 'Cambio de plan',
  'org.suspended': 'Suspendido',
  'org.reactivated': 'Reactivado',
};

export function AdminPage() {
  const session = useSession();
  const [denied, setDenied] = useState<'no' | 'mfa' | 'forbidden'>('no');
  if (session === undefined) return <Spinner />;
  if (!session) return <LoginForm title="Panel maestro" />;
  if (denied === 'mfa') return <MfaChallenge onDone={() => setDenied('no')} />;
  if (denied === 'forbidden')
    return (
      <main className="mx-auto max-w-md px-4 pt-8">
        <Alert tone="error">Este usuario no tiene acceso al panel maestro.</Alert>
        <button className="mt-4 text-sm underline" onClick={() => void supabase.auth.signOut()}>
          Salir
        </button>
      </main>
    );
  return <Admin token={session.access_token} onDenied={setDenied} />;
}

function Admin({ token, onDenied }: { token: string; onDenied: (d: 'mfa' | 'forbidden') => void }) {
  const [orgs, setOrgs] = useState<OrgRow[] | null>(null);
  const [plans, setPlans] = useState<Plans | null>(null);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const { msg, busy, run } = useAction();
  const call = useCallback(
    <T,>(path: string, init: Parameters<typeof api>[1] = {}) =>
      api<T>(`/v1/admin${path}`, { ...init, token }),
    [token],
  );

  const load = useCallback(async () => {
    try {
      const [o, p, a] = await Promise.all([
        call<{ organizations: OrgRow[] }>('/orgs'),
        call<Plans>('/plans'),
        call<{ entries: AuditRow[] }>('/audit'),
      ]);
      setOrgs(o.organizations);
      setPlans(p);
      setAudit(a.entries);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'mfa_required') onDenied('mfa');
      else if (e instanceof ApiError && (e.status === 404 || e.status === 403)) onDenied('forbidden');
    }
  }, [call, onDenied]);
  useEffect(() => void load(), [load]);

  function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    void run(async () => {
      const r = await call<{ invitation: { sentTo: string } }>('/orgs', {
        method: 'POST',
        json: {
          name: String(f.get('name')),
          template: String(f.get('template')),
          planCode: String(f.get('plan')),
          ownerName: String(f.get('ownerName')),
          ownerEmail: String(f.get('ownerEmail')),
        },
      });
      form.reset();
      await load();
      return r;
    }, 'Negocio creado en preparación. Enviamos la invitación al dueño.');
  }

  if (!orgs || !plans) return <Spinner />;
  return (
    <div className="mx-auto min-h-dvh w-full max-w-3xl space-y-4 px-4 pb-10 pt-3">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Panel maestro</h1>
        <button className="text-sm underline" onClick={() => void supabase.auth.signOut()}>
          Salir
        </button>
      </header>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}

      <Card title="Nuevo negocio" testId="new-org">
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={create}>
          <Field label="Nombre del negocio">
            <input name="name" className={inputCls} required maxLength={60} />
          </Field>
          <Field label="Rubro (plantilla)">
            <select name="template" className={inputCls} required defaultValue="">
              <option value="" disabled>
                Elige…
              </option>
              {plans.templates.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Plan">
            <select name="plan" className={inputCls} defaultValue="start">
              {plans.plans.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.name} ({p.limits.branches ?? '∞'} suc. · {p.limits.staff ?? '∞'} trab.)
                </option>
              ))}
            </select>
          </Field>
          <Field label="Nombre del dueño">
            <input name="ownerName" className={inputCls} required maxLength={60} />
          </Field>
          <Field label="Correo del dueño">
            <input name="ownerEmail" type="email" className={inputCls} required maxLength={120} />
          </Field>
          <div className="flex items-end">
            <SmallButton type="submit" tone="primary" disabled={busy} className="w-full">
              Crear e invitar
            </SmallButton>
          </div>
        </form>
      </Card>

      <Card title={`Negocios (${orgs.length})`} testId="orgs">
        <ul className="divide-y divide-gray-100">
          {orgs.map((o) => (
            <OrgItem key={o.id} org={o} plans={plans} busy={busy} run={run} call={call} reload={load} />
          ))}
        </ul>
      </Card>

      <Card title="Auditoría de plataforma">
        <ul className="divide-y divide-gray-100 text-sm">
          {audit.slice(0, 30).map((a) => (
            <li key={a.id} className="flex justify-between gap-2 py-2">
              <span>
                {ACTION[a.action] ?? a.action} · {a.organization ?? '—'}
              </span>
              <span className="shrink-0 text-gray-500">{fmtDateTime(a.createdAt)}</span>
            </li>
          ))}
        </ul>
      </Card>
      <PoweredBy />
    </div>
  );
}

function OrgItem({
  org: o,
  plans,
  busy,
  run,
  call,
  reload,
}: {
  org: OrgRow;
  plans: Plans;
  busy: boolean;
  run: ReturnType<typeof useAction>['run'];
  call: <T>(path: string, init?: Parameters<typeof api>[1]) => Promise<T>;
  reload: () => Promise<void>;
}) {
  const [label, tone] = STATUS_LABEL[o.status];
  const act = (path: string, ok: string, json?: unknown) =>
    void run(async () => {
      await call(`/orgs/${o.id}${path}`, { method: 'POST', json });
      await reload();
    }, ok);
  return (
    <li className="py-3" data-testid="org-row">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">
            {o.name} <Badge tone={tone}>{label}</Badge>
          </p>
          <p className="text-xs text-gray-500">
            {o.owner ?? 'sin dueño'} · {o.customers} clientes · {o.movements30d} mov. 30 días
          </p>
          <p className="text-xs text-gray-500">
            {o.branches}/{o.limits.branches ?? '∞'} sucursales · {o.staff}/{o.limits.staff ?? '∞'}{' '}
            trabajadores
          </p>
        </div>
        <select
          aria-label={`Plan de ${o.name}`}
          className="h-10 shrink-0 rounded-lg border border-gray-300 bg-white px-2 text-sm"
          value={o.plan}
          disabled={busy}
          onChange={(e) => act('/plan', `Plan de ${o.name} actualizado.`, { planCode: e.target.value })}
        >
          {plans.plans.map((p) => (
            <option key={p.code} value={p.code}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {o.status === 'draft' && (
          <SmallButton
            tone="primary"
            disabled={busy}
            onClick={() => act('/activate', `${o.name} publicado: su QR ya registra clientes.`)}
          >
            Publicar
          </SmallButton>
        )}
        <SmallButton disabled={busy} onClick={() => act('/invite', `Invitación reenviada a ${o.owner}.`)}>
          Reenviar invitación
        </SmallButton>
        {o.status === 'live' && (
          <SmallButton
            tone="danger"
            disabled={busy}
            onClick={() => {
              const reason = window.prompt(`Motivo para suspender ${o.name}:`);
              if (reason) act('/suspend', `${o.name} suspendido.`, { reason });
            }}
          >
            Suspender
          </SmallButton>
        )}
        {o.status === 'suspended' && (
          <SmallButton
            disabled={busy}
            onClick={() => {
              const reason = window.prompt(`Motivo para reactivar ${o.name}:`);
              if (reason) act('/reactivate', `${o.name} reactivado.`, { reason });
            }}
          >
            Reactivar
          </SmallButton>
        )}
      </div>
    </li>
  );
}

/** Segundo factor (TOTP) cuando la plataforma lo exige para el superadmin. */
function MfaChallenge({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  async function verify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const code = String(new FormData(e.currentTarget).get('code') ?? '').trim();
    const factors = await supabase.auth.mfa.listFactors();
    const totp = factors.data?.totp[0];
    if (!totp) return setError('Tu usuario no tiene un segundo factor configurado. Configúralo con soporte.');
    const r = await supabase.auth.mfa.challengeAndVerify({ factorId: totp.id, code });
    if (r.error) return setError('Código incorrecto o vencido.');
    onDone();
  }
  return (
    <main className="mx-auto max-w-md px-4 pt-8">
      <h1 className="text-2xl font-semibold">Verificación en dos pasos</h1>
      <form className="mt-6 space-y-3" onSubmit={verify}>
        <input
          name="code"
          inputMode="numeric"
          maxLength={6}
          required
          placeholder="Código de 6 dígitos"
          className={inputCls}
        />
        {error && <Alert tone="error">{error}</Alert>}
        <SmallButton type="submit" tone="primary" className="w-full">
          Verificar
        </SmallButton>
      </form>
    </main>
  );
}
