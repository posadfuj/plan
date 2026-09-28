/**
 * Equipo: trabajadores de caja (PIN y sucursales donde pueden abrir turno), dentro del tope del plan,
 * y el PIN del dueño/admin que autoriza excepciones en caja.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert } from '../components/ui';
import { Badge, Card, Field, inputCls, SmallButton, useAction, usageText, usePanel } from './shared';

export interface TeamRow {
  id: string;
  name: string;
  role: 'owner' | 'admin' | 'staff';
  status: 'active' | 'inactive';
  hasPin: boolean;
  locked: boolean;
  isMe: boolean;
  branchIds: string[];
}
export interface BranchRow {
  id: string;
  name: string;
  status: 'active' | 'inactive';
}

const ROLE = { owner: 'Dueño', admin: 'Admin', staff: 'Caja' } as const;

export function TeamSection() {
  const { call, settings, reload } = usePanel();
  const [team, setTeam] = useState<TeamRow[]>([]);
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [pinFor, setPinFor] = useState<TeamRow | null>(null);
  const { msg, busy, run } = useAction();

  const load = useCallback(async () => {
    const [t, b] = await Promise.all([
      call<{ team: TeamRow[] }>('/team'),
      call<{ branches: BranchRow[] }>('/branches'),
    ]);
    setTeam(t.team);
    setBranches(b.branches.filter((x) => x.status === 'active'));
  }, [call]);
  useEffect(() => void load(), [load]);

  const refresh = async () => {
    await load();
    await reload(); // uso del plan
  };
  const staff = team.filter((p) => p.role === 'staff' && p.status === 'active');
  const managers = team.filter((p) => p.role !== 'staff' && p.status === 'active');
  const inactive = team.filter((p) => p.role === 'staff' && p.status === 'inactive');
  const atLimit = settings.limits.staff !== null && settings.usage.staff >= settings.limits.staff;
  const multi = branches.length > 1;
  const branchNames = (ids: string[]) =>
    ids.length === 0
      ? 'Todas las sucursales'
      : ids.map((id) => branches.find((b) => b.id === id)?.name ?? '—').join(', ');

  return (
    <>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <Card
        title="Trabajadores de caja"
        testId="team-staff"
        aside={
          <span className="text-xs text-gray-500" data-testid="staff-usage">
            {usageText(settings.usage.staff, settings.limits.staff, 'trabajador', 'trabajadores')} · plan{' '}
            {settings.plan.name}
          </span>
        }
      >
        <p className="mb-2 text-sm text-gray-600">
          Entran a la caja con su nombre y su PIN. No necesitan correo ni contraseña.
        </p>
        <ul className="divide-y divide-gray-100">
          {staff.map((p) =>
            editing === p.id ? (
              <li key={p.id} className="py-3">
                <StaffForm
                  person={p}
                  branches={branches}
                  busy={busy}
                  onCancel={() => setEditing(null)}
                  onSave={(body) =>
                    void run(async () => {
                      await call(`/team/${p.id}`, { method: 'PATCH', json: body });
                      setEditing(null);
                      await refresh();
                    }, `Cambios guardados para ${body.name}.`)
                  }
                />
              </li>
            ) : (
              <li key={p.id} className="py-3" data-testid="staff-row">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium">{p.name}</p>
                    <p className="text-xs text-gray-500">
                      {p.locked
                        ? 'Bloqueado por intentos: cámbiale el PIN para desbloquear'
                        : p.hasPin
                          ? 'Con PIN'
                          : 'Sin PIN'}
                      {multi && ` · ${branchNames(p.branchIds)}`}
                    </p>
                  </div>
                  {p.locked && <Badge tone="red">Bloqueado</Badge>}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <SmallButton onClick={() => setEditing(p.id)}>
                    {multi ? 'Editar / sucursales' : 'Editar'}
                  </SmallButton>
                  <SmallButton onClick={() => setPinFor(p)}>Cambiar PIN</SmallButton>
                  <SmallButton
                    tone="danger"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await call(`/team/${p.id}/deactivate`, { method: 'POST' });
                        await refresh();
                      }, `${p.name} ya no puede entrar a la caja.`)
                    }
                  >
                    Dar de baja
                  </SmallButton>
                </div>
              </li>
            ),
          )}
          {!staff.length && (
            <li className="py-3 text-sm text-gray-500">Todavía no agregaste trabajadores.</li>
          )}
        </ul>

        {pinFor && (
          <PinForm
            person={pinFor}
            busy={busy}
            onCancel={() => setPinFor(null)}
            onSave={(pin) =>
              void run(async () => {
                await call(`/team/${pinFor.id}/pin`, { method: 'POST', json: { pin } });
                setPinFor(null);
                await load();
              }, `PIN actualizado para ${pinFor.name}.`)
            }
          />
        )}

        <div className="mt-4 rounded-xl bg-gray-50 p-3">
          <p className="mb-2 text-sm font-medium">Agregar trabajador</p>
          {atLimit ? (
            <Alert tone="info">
              Llegaste al tope de tu plan {settings.plan.name} ({settings.limits.staff} trabajadores). Da de
              baja a alguien o pide a Aiment un plan mayor.
            </Alert>
          ) : (
            <StaffForm
              branches={branches}
              busy={busy}
              withPin
              onSave={(body, reset) =>
                void run(async () => {
                  await call('/team', { method: 'POST', json: body });
                  reset();
                  await refresh();
                }, `${body.name} ya puede entrar a la caja con su PIN.`)
              }
            />
          )}
        </div>

        {inactive.length > 0 && (
          <details className="mt-4">
            <summary className="cursor-pointer text-sm font-medium">
              Dados de baja ({inactive.length})
            </summary>
            <ul className="mt-2 divide-y divide-gray-100">
              {inactive.map((p) => (
                <li key={p.id} className="flex items-center justify-between py-2 text-sm">
                  <span className="text-gray-500">{p.name}</span>
                  <SmallButton
                    disabled={busy || atLimit}
                    onClick={() =>
                      void run(async () => {
                        await call(`/team/${p.id}/reactivate`, { method: 'POST' });
                        await refresh();
                      }, `${p.name} vuelve a tener acceso a la caja.`)
                    }
                  >
                    Reactivar
                  </SmallButton>
                </li>
              ))}
            </ul>
          </details>
        )}
      </Card>

      <Card title="Dueño y administradores">
        <ul className="divide-y divide-gray-100">
          {managers.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-2 py-3">
              <span>
                {p.name} <span className="text-gray-400">· {ROLE[p.role]}</span>
                {p.isMe && <span className="text-gray-400"> (tú)</span>}
                <span className="block text-xs text-gray-500">
                  {p.hasPin ? 'Con PIN para autorizar excepciones' : 'Sin PIN'}
                </span>
              </span>
              {p.isMe && (
                <SmallButton onClick={() => setPinFor(p)}>
                  {p.hasPin ? 'Cambiar mi PIN' : 'Definir mi PIN'}
                </SmallButton>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-gray-500">
          Tu PIN autoriza en caja las excepciones (por ejemplo, sumar dos veces el mismo día) y te deja
          atender la caja tú mismo.
        </p>
      </Card>
    </>
  );
}

function StaffForm({
  person,
  branches,
  busy,
  withPin,
  onSave,
  onCancel,
}: {
  person?: TeamRow;
  branches: BranchRow[];
  busy: boolean;
  withPin?: boolean;
  onSave: (body: { name: string; pin?: string; branchIds: string[] }, reset: () => void) => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(person?.name ?? '');
  const [pin, setPin] = useState('');
  const [all, setAll] = useState(!person?.branchIds.length);
  const [selected, setSelected] = useState<string[]>(person?.branchIds ?? []);
  const multi = branches.length > 1;
  const reset = () => {
    setName('');
    setPin('');
    setAll(true);
    setSelected([]);
  };
  function submit(e: FormEvent) {
    e.preventDefault();
    onSave({ name, ...(withPin ? { pin } : {}), branchIds: all || !multi ? [] : selected }, reset);
  }
  return (
    <form className="space-y-2" onSubmit={submit}>
      <Field label="Nombre">
        <input
          className={inputCls}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={40}
          required
          placeholder="Ej.: Jhon"
        />
      </Field>
      {withPin && (
        <Field label="PIN (4 a 6 números)" hint="Evita 1234, 1111 o tu año de nacimiento.">
          <input
            className={inputCls}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            inputMode="numeric"
            pattern="[0-9]{4,6}"
            maxLength={6}
            required
            autoComplete="off"
          />
        </Field>
      )}
      {multi && (
        <fieldset className="space-y-1" data-testid="staff-branches">
          <legend className="text-sm font-medium">¿En qué sucursales puede abrir turno?</legend>
          <label className="flex min-h-11 items-center gap-3">
            <input type="radio" className="h-5 w-5" checked={all} onChange={() => setAll(true)} />
            Todas las sucursales
          </label>
          <label className="flex min-h-11 items-center gap-3">
            <input type="radio" className="h-5 w-5" checked={!all} onChange={() => setAll(false)} />
            Solo en…
          </label>
          {!all && (
            <div className="ml-8 space-y-1">
              {branches.map((b) => (
                <label key={b.id} className="flex min-h-11 items-center gap-3">
                  <input
                    type="checkbox"
                    className="h-5 w-5"
                    checked={selected.includes(b.id)}
                    onChange={(e) =>
                      setSelected((s) => (e.target.checked ? [...s, b.id] : s.filter((x) => x !== b.id)))
                    }
                  />
                  {b.name}
                </label>
              ))}
              {!selected.length && <p className="text-xs text-red-700">Elige al menos una sucursal.</p>}
            </div>
          )}
          {person && (
            <p className="text-xs text-gray-500">
              Si le quitas una sucursal donde tiene un turno abierto, ese turno se cierra.
            </p>
          )}
        </fieldset>
      )}
      <div className="flex gap-2">
        <SmallButton
          type="submit"
          tone="primary"
          disabled={busy || (multi && !all && !selected.length)}
          className="flex-1"
        >
          {person ? 'Guardar' : 'Agregar'}
        </SmallButton>
        {onCancel && (
          <SmallButton onClick={onCancel} className="flex-1">
            Cancelar
          </SmallButton>
        )}
      </div>
    </form>
  );
}

function PinForm({
  person,
  busy,
  onSave,
  onCancel,
}: {
  person: TeamRow;
  busy: boolean;
  onSave: (pin: string) => void;
  onCancel: () => void;
}) {
  const [pin, setPin] = useState('');
  return (
    <form
      className="mt-3 space-y-2 rounded-xl bg-gray-50 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(pin);
      }}
    >
      <p className="text-sm font-medium">
        Nuevo PIN para {person.name}
        {person.isMe && ' (con él autorizas excepciones en caja)'}
      </p>
      <input
        aria-label="Nuevo PIN"
        className={inputCls}
        value={pin}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
        inputMode="numeric"
        pattern="[0-9]{4,6}"
        maxLength={6}
        placeholder="4 a 6 números"
        required
        autoComplete="off"
      />
      <div className="flex gap-2">
        <SmallButton type="submit" tone="primary" disabled={busy} className="flex-1">
          Guardar PIN
        </SmallButton>
        <SmallButton onClick={onCancel} className="flex-1">
          Cancelar
        </SmallButton>
      </div>
    </form>
  );
}
