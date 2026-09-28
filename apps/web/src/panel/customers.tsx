/**
 * Clientes: lista con búsqueda (nombre, celular, código o correo) y filtro, y la ficha con ajuste,
 * anulaciones, bloqueo, invalidar el enlace de la tarjeta, QR de recuperación y baja.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, newIdempotencyKey } from '../api';
import { Alert } from '../components/ui';
import { Badge, Card, fmtDate, fmtDateTime, inputCls, SmallButton, useAction, usePanel } from './shared';

interface Row {
  id: string;
  fullName: string;
  phone: string;
  membershipId: string;
  status: 'active' | 'blocked';
  shortCode: string;
  balance: number;
  lastActivityAt: string | null;
}
interface Detail {
  customer: {
    id: string;
    fullName: string;
    phone: string;
    email: string | null;
    birthDate: string | null;
    createdAt: string;
  };
  marketing: boolean;
  membership: {
    id: string;
    status: 'active' | 'blocked';
    balance: number;
    lifetimeEarned: number;
    shortCode: string;
    lastActivityAt: string | null;
  } | null;
  rewards: { id: string; name: string; expiresAt: string | null }[];
  movements: {
    id: string;
    kind: string;
    delta: number;
    balanceAfter: number;
    reason: string | null;
    by: string | null;
    createdAt: string;
    reversed: boolean;
    canVoid: boolean;
  }[];
  redemptions: {
    id: string;
    reward: string;
    status: string;
    by: string | null;
    createdAt: string;
    canVoid: boolean;
  }[];
}

const KIND: Record<string, string> = {
  earn: 'Visita / compra',
  bonus: 'Bono de bienvenida',
  convert: 'Premio completado',
  redeem: 'Canje',
  adjust: 'Ajuste',
  reversal: 'Anulación',
  expire: 'Vencimiento',
};
const PAGE = 25;

export function CustomersSection() {
  const [selected, setSelected] = useState<string | null>(null);
  const [unit, setUnit] = useState('');
  const { call } = usePanel();
  useEffect(() => {
    void call<{ unitLabel: string }>('/program').then((p) => setUnit(p.unitLabel));
  }, [call]);
  return selected ? (
    <CustomerDetail id={selected} unit={unit} onBack={() => setSelected(null)} />
  ) : (
    <CustomerList unit={unit} onOpen={setSelected} />
  );
}

// La lista recuerda la búsqueda al volver de una ficha.
let lastQuery = { q: '', status: 'all', offset: 0 };

function CustomerList({ unit, onOpen }: { unit: string; onOpen: (id: string) => void }) {
  const { call } = usePanel();
  const [query, setQuery] = useState(lastQuery);
  const [text, setText] = useState(lastQuery.q);
  const [data, setData] = useState<{ customers: Row[]; total: number } | null>(null);

  useEffect(() => {
    lastQuery = query;
    const p = new URLSearchParams({
      q: query.q,
      status: query.status,
      limit: String(PAGE),
      offset: String(query.offset),
    });
    void call<{ customers: Row[]; total: number }>(`/customers?${p}`).then(setData);
  }, [call, query]);

  // Búsqueda mientras se escribe (con una pausa corta).
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (text === query.q) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setQuery((q) => ({ ...q, q: text.trim(), offset: 0 })), 350);
    return () => clearTimeout(timer.current);
  }, [text, query.q]);

  return (
    <Card title={data ? `Clientes (${data.total})` : 'Clientes'} testId="customers">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="search"
          aria-label="Buscar cliente"
          placeholder="Nombre, celular, código o correo"
          className={inputCls}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <select
          aria-label="Estado"
          className={`${inputCls} sm:w-44`}
          value={query.status}
          onChange={(e) => setQuery((q) => ({ ...q, status: e.target.value, offset: 0 }))}
        >
          <option value="all">Todos</option>
          <option value="active">Activos</option>
          <option value="blocked">Bloqueados</option>
        </select>
      </div>
      <ul className="mt-3 divide-y divide-gray-100">
        {data?.customers.map((c) => (
          <li key={c.id}>
            <button
              className="flex min-h-14 w-full items-center justify-between gap-3 py-2 text-left"
              onClick={() => onOpen(c.id)}
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">
                  {c.fullName} {c.status === 'blocked' && <Badge tone="red">Bloqueado</Badge>}
                </span>
                <span className="block text-xs text-gray-500">
                  {c.phone} · {c.shortCode} · última visita {fmtDate(c.lastActivityAt)}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block text-lg font-bold">{c.balance}</span>
                <span className="block text-xs text-gray-500">{unit}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {data && data.total === 0 && (
        <p className="py-6 text-center text-sm text-gray-500">No hay clientes con ese criterio.</p>
      )}
      {data && data.total > PAGE && (
        <div className="mt-3 flex items-center justify-between text-sm">
          <SmallButton
            disabled={query.offset === 0}
            onClick={() => setQuery((q) => ({ ...q, offset: Math.max(0, q.offset - PAGE) }))}
          >
            ← Anteriores
          </SmallButton>
          <span className="text-gray-500">
            {query.offset + 1}–{Math.min(query.offset + PAGE, data.total)} de {data.total}
          </span>
          <SmallButton
            disabled={query.offset + PAGE >= data.total}
            onClick={() => setQuery((q) => ({ ...q, offset: q.offset + PAGE }))}
          >
            Siguientes →
          </SmallButton>
        </div>
      )}
    </Card>
  );
}

function CustomerDetail({ id, unit, onBack }: { id: string; unit: string; onBack: () => void }) {
  const { call, token, orgId } = usePanel();
  const [d, setD] = useState<Detail | null>(null);
  const [gone, setGone] = useState(false);
  const { msg, setMsg, busy, run } = useAction();
  const [recovery, setRecovery] = useState<{ qrSvg: string; expiresAt: string } | null>(null);
  const [dialog, setDialog] = useState<
    | null
    | 'edit'
    | 'adjust'
    | 'block'
    | 'rotate'
    | 'delete'
    | { void: string; label: string; redemption?: boolean }
  >(null);

  const load = useCallback(() => call<Detail>(`/customers/${id}`).then(setD), [call, id]);
  useEffect(() => void load(), [load]);

  if (gone)
    return (
      <Card>
        <Alert tone="ok">
          Cliente dado de baja: sus datos personales se borraron y su tarjeta dejó de funcionar.
        </Alert>
        <SmallButton className="mt-3" onClick={onBack}>
          ← Volver a clientes
        </SmallButton>
      </Card>
    );
  if (!d) return null;
  const m = d.membership;

  // Operaciones de saldo: una clave de idempotencia por intención (un reintento no duplica).
  const ledgerCall = (path: string, json: unknown) =>
    api(`/v1/orgs/${orgId}${path}`, { method: 'POST', token, json, idempotencyKey: newIdempotencyKey() });

  return (
    <div className="space-y-4" data-testid="customer-detail">
      <SmallButton onClick={onBack}>← Clientes</SmallButton>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <Card
        title={d.customer.fullName}
        aside={
          m?.status === 'blocked' ? <Badge tone="red">Bloqueado</Badge> : <Badge tone="green">Activo</Badge>
        }
      >
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
          <dt className="text-gray-500">Celular</dt>
          <dd>{d.customer.phone}</dd>
          <dt className="text-gray-500">Correo</dt>
          <dd className="break-all">{d.customer.email ?? '—'}</dd>
          <dt className="text-gray-500">Cumpleaños</dt>
          <dd>{d.customer.birthDate ? d.customer.birthDate.split('-').reverse().join('/') : '—'}</dd>
          <dt className="text-gray-500">Promociones</dt>
          <dd>{d.marketing ? 'Acepta' : 'No acepta'}</dd>
          <dt className="text-gray-500">Cliente desde</dt>
          <dd>{fmtDate(d.customer.createdAt)}</dd>
          <dt className="text-gray-500">Código de tarjeta</dt>
          <dd className="font-mono">{m?.shortCode}</dd>
        </dl>
        {m && (
          <div className="mt-4 flex items-end justify-between rounded-xl bg-gray-50 p-3">
            <div>
              <p className="text-3xl font-bold" data-testid="detail-balance">
                {m.balance} <span className="text-base font-medium text-gray-500">{unit}</span>
              </p>
              <p className="text-xs text-gray-500">
                {m.lifetimeEarned} ganados en total · última visita {fmtDate(m.lastActivityAt)}
              </p>
            </div>
          </div>
        )}
        {d.rewards.length > 0 && (
          <p className="mt-3 text-sm">
            Premios por canjear:{' '}
            <strong>
              {d.rewards
                .map((r) => r.name + (r.expiresAt ? ` (vence ${fmtDate(r.expiresAt)})` : ''))
                .join(', ')}
            </strong>
          </p>
        )}
      </Card>

      {m && (
        <Card title="Acciones">
          <div className="grid grid-cols-2 gap-2">
            <SmallButton onClick={() => setDialog('edit')}>Editar datos</SmallButton>
            <SmallButton onClick={() => setDialog('adjust')}>Ajustar saldo</SmallButton>
            <SmallButton
              disabled={busy || m.status === 'blocked'}
              onClick={() =>
                void run(async () => {
                  setRecovery(await call(`/memberships/${m.id}/recovery`, { method: 'POST' }));
                }, undefined)
              }
            >
              QR de recuperación
            </SmallButton>
            {m.status === 'blocked' ? (
              <SmallButton
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await call(`/memberships/${m.id}/unblock`, { method: 'POST' });
                    await load();
                  }, 'Cliente desbloqueado: ya puede sumar y canjear.')
                }
              >
                Desbloquear
              </SmallButton>
            ) : (
              <SmallButton onClick={() => setDialog('block')}>Bloquear</SmallButton>
            )}
            <SmallButton onClick={() => setDialog('rotate')}>Invalidar enlace</SmallButton>
            <SmallButton tone="danger" className="col-span-2" onClick={() => setDialog('delete')}>
              Dar de baja (borrar datos)
            </SmallButton>
          </div>

          {recovery && (
            <div className="mt-4 text-center" data-testid="recovery-qr">
              <p className="text-sm font-medium">Para {d.customer.fullName}: que lo escanee con su celular</p>
              <div
                className="mx-auto my-3 h-56 w-56 [&>svg]:h-full [&>svg]:w-full"
                dangerouslySetInnerHTML={{ __html: recovery.qrSvg }}
              />
              <p className="text-xs text-gray-500">
                Un solo uso · vence {new Date(recovery.expiresAt).toLocaleTimeString('es-PE')}. Verifica antes
                que sea la persona.
              </p>
            </div>
          )}

          {dialog === 'edit' && (
            <EditCustomerDialog
              name={d.customer.fullName}
              phone={d.customer.phone}
              busy={busy}
              onCancel={() => setDialog(null)}
              onConfirm={(json) =>
                void run(async () => {
                  await call(`/customers/${d.customer.id}`, { method: 'PATCH', json });
                  setDialog(null);
                  await load();
                }, 'Datos actualizados. La tarjeta y el historial siguen igual.')
              }
            />
          )}
          {dialog === 'adjust' && (
            <ReasonDialog
              title="Ajustar saldo"
              help={`Suma o resta ${unit} por un motivo (por ejemplo, una visita que no se registró). Queda en el historial.`}
              withDelta
              busy={busy}
              confirm="Aplicar ajuste"
              onCancel={() => setDialog(null)}
              onConfirm={(reason, delta) =>
                void run(async () => {
                  await ledgerCall(`/memberships/${m.id}/adjust`, { delta, reason });
                  setDialog(null);
                  await load();
                }, 'Ajuste aplicado.')
              }
            />
          )}
          {dialog === 'block' && (
            <ReasonDialog
              title="Bloquear cliente"
              help="La caja no podrá sumar ni canjear y su tarjeta dirá que consulte en el local. Su saldo no cambia."
              busy={busy}
              confirm="Bloquear"
              onCancel={() => setDialog(null)}
              onConfirm={(reason) =>
                void run(async () => {
                  await call(`/memberships/${m.id}/block`, { method: 'POST', json: { reason } });
                  setDialog(null);
                  await load();
                }, 'Cliente bloqueado.')
              }
            />
          )}
          {dialog === 'rotate' && (
            <ConfirmDialog
              title="Invalidar el enlace de su tarjeta"
              help="Úsalo si perdió el celular o compartió su enlace. El enlace actual deja de funcionar; para volver a entrar necesitará el QR de recuperación o su correo."
              confirm="Invalidar enlace"
              busy={busy}
              onCancel={() => setDialog(null)}
              onConfirm={() =>
                void run(async () => {
                  await call(`/memberships/${m.id}/rotate-card`, { method: 'POST' });
                  setDialog(null);
                }, 'Enlace invalidado. Genera el QR de recuperación para darle uno nuevo.')
              }
            />
          )}
          {dialog === 'delete' && (
            <DeleteDialog
              busy={busy}
              onCancel={() => setDialog(null)}
              onConfirm={(confirm, reason) =>
                void run(async () => {
                  await call(`/customers/${d.customer.id}/anonymize`, {
                    method: 'POST',
                    json: { confirm, reason },
                  });
                  setGone(true);
                })
              }
            />
          )}
          {dialog && typeof dialog === 'object' && (
            <ReasonDialog
              title={`Anular: ${dialog.label}`}
              help="La anulación queda en el historial con su motivo. No se borra nada."
              busy={busy}
              confirm="Anular"
              onCancel={() => setDialog(null)}
              onConfirm={(reason) =>
                void run(async () => {
                  await ledgerCall(
                    dialog.redemption ? `/redemptions/${dialog.void}/void` : `/ledger/${dialog.void}/void`,
                    {
                      reason,
                    },
                  );
                  setDialog(null);
                  await load();
                }, 'Movimiento anulado.')
              }
            />
          )}
        </Card>
      )}

      <Card title="Historial">
        <ul className="divide-y divide-gray-100 text-sm" data-testid="movements">
          {d.movements
            .filter((x) => x.kind !== 'convert')
            .map((x) => (
              <li key={x.id} className="flex items-center justify-between gap-2 py-2">
                <span className="min-w-0">
                  <span className={x.reversed ? 'line-through' : ''}>{KIND[x.kind] ?? x.kind}</span>{' '}
                  <span className="text-gray-400">· {fmtDateTime(x.createdAt)}</span>
                  <span className="block text-xs text-gray-500">
                    {x.by ?? (x.kind === 'bonus' ? 'Automático' : '')}
                    {x.reason ? ` · ${x.reason}` : ''}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className={x.delta > 0 ? 'text-emerald-700' : 'text-gray-700'}>
                    {x.delta > 0 ? '+' : ''}
                    {x.delta}
                  </span>
                  {x.canVoid && (
                    <button
                      className="min-h-9 rounded-lg px-2 text-xs font-semibold text-red-700 ring-1 ring-red-200"
                      onClick={() => {
                        setMsg(null);
                        setDialog({ void: x.id, label: KIND[x.kind] ?? x.kind });
                      }}
                    >
                      Anular
                    </button>
                  )}
                </span>
              </li>
            ))}
          {d.redemptions.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-2 py-2">
              <span>
                <span className={r.status === 'voided' ? 'line-through' : ''}>Canje: {r.reward}</span>{' '}
                <span className="text-gray-400">· {fmtDateTime(r.createdAt)}</span>
              </span>
              {r.canVoid && (
                <button
                  className="min-h-9 rounded-lg px-2 text-xs font-semibold text-red-700 ring-1 ring-red-200"
                  onClick={() => setDialog({ void: r.id, label: `canje de ${r.reward}`, redemption: true })}
                >
                  Anular
                </button>
              )}
            </li>
          ))}
          {!d.movements.length && !d.redemptions.length && (
            <li className="py-3 text-gray-500">Sin movimientos todavía.</li>
          )}
        </ul>
      </Card>
    </div>
  );
}

/** Corregir nombre y/o celular. Solo se envía lo que cambió; el motivo queda en la auditoría. */
function EditCustomerDialog({
  name,
  phone,
  busy,
  onConfirm,
  onCancel,
}: {
  name: string;
  phone: string;
  busy: boolean;
  onConfirm: (json: { fullName?: string; phone?: string; reason: string }) => void;
  onCancel: () => void;
}) {
  const [fullName, setFullName] = useState(name);
  const [cel, setCel] = useState(phone);
  const [reason, setReason] = useState('');
  return (
    <form
      className="mt-4 space-y-2 rounded-xl bg-gray-50 p-3"
      role="dialog"
      aria-label="Editar datos del cliente"
      onSubmit={(e) => {
        e.preventDefault();
        onConfirm({
          ...(fullName.trim() !== name ? { fullName } : {}),
          ...(cel.replace(/\s/g, '') !== phone ? { phone: cel } : {}),
          reason,
        });
      }}
    >
      <p className="font-medium">Editar datos del cliente</p>
      <p className="text-xs text-gray-600">
        Su tarjeta, su saldo y su historial no cambian. Si el celular ya lo tiene otro cliente, no se permite.
      </p>
      <input
        aria-label="Nombre"
        className={inputCls}
        value={fullName}
        onChange={(e) => setFullName(e.target.value)}
        maxLength={80}
        required
      />
      <input
        aria-label="Celular"
        className={inputCls}
        type="tel"
        inputMode="tel"
        value={cel}
        onChange={(e) => setCel(e.target.value)}
        required
      />
      <input
        aria-label="Motivo del cambio"
        placeholder="Motivo del cambio"
        className={inputCls}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        minLength={5}
        maxLength={300}
        required
      />
      <div className="flex gap-2">
        <SmallButton type="submit" tone="primary" disabled={busy} className="flex-1">
          Guardar
        </SmallButton>
        <SmallButton onClick={onCancel} className="flex-1">
          Cancelar
        </SmallButton>
      </div>
    </form>
  );
}

function ReasonDialog({
  title,
  help,
  confirm,
  busy,
  withDelta,
  onConfirm,
  onCancel,
}: {
  title: string;
  help: string;
  confirm: string;
  busy: boolean;
  withDelta?: boolean;
  onConfirm: (reason: string, delta: number) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const [delta, setDelta] = useState('1');
  return (
    <form
      className="mt-4 space-y-2 rounded-xl bg-gray-50 p-3"
      role="dialog"
      aria-label={title}
      onSubmit={(e) => {
        e.preventDefault();
        onConfirm(reason, Number(delta));
      }}
    >
      <p className="font-medium">{title}</p>
      <p className="text-xs text-gray-600">{help}</p>
      {withDelta && (
        <input
          aria-label="Cantidad (negativa para restar)"
          className={inputCls}
          type="number"
          step={1}
          value={delta}
          onChange={(e) => setDelta(e.target.value)}
          required
        />
      )}
      <input
        aria-label="Motivo"
        placeholder="Motivo"
        className={inputCls}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        minLength={5}
        maxLength={300}
        required
      />
      <div className="flex gap-2">
        <SmallButton type="submit" tone="primary" disabled={busy} className="flex-1">
          {confirm}
        </SmallButton>
        <SmallButton onClick={onCancel} className="flex-1">
          Cancelar
        </SmallButton>
      </div>
    </form>
  );
}

function ConfirmDialog(props: {
  title: string;
  help: string;
  confirm: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="mt-4 space-y-2 rounded-xl bg-gray-50 p-3" role="dialog" aria-label={props.title}>
      <p className="font-medium">{props.title}</p>
      <p className="text-xs text-gray-600">{props.help}</p>
      <div className="flex gap-2">
        <SmallButton tone="primary" disabled={props.busy} onClick={props.onConfirm} className="flex-1">
          {props.confirm}
        </SmallButton>
        <SmallButton onClick={props.onCancel} className="flex-1">
          Cancelar
        </SmallButton>
      </div>
    </div>
  );
}

function DeleteDialog({
  busy,
  onConfirm,
  onCancel,
}: {
  busy: boolean;
  onConfirm: (c: string, r: string) => void;
  onCancel: () => void;
}) {
  const [word, setWord] = useState('');
  const [reason, setReason] = useState('');
  return (
    <form
      className="mt-4 space-y-2 rounded-xl bg-red-50 p-3"
      role="dialog"
      aria-label="Dar de baja al cliente"
      onSubmit={(e) => {
        e.preventDefault();
        onConfirm(word.trim().toUpperCase(), reason);
      }}
    >
      <p className="font-medium text-red-800">Dar de baja al cliente</p>
      <p className="text-xs text-red-800">
        Se borran su nombre, celular, correo y cumpleaños, y su tarjeta y su QR dejan de funcionar. Su
        historial queda sin datos personales para tus reportes. <strong>No se puede deshacer.</strong>
      </p>
      <input
        aria-label="Motivo (opcional)"
        placeholder="Motivo (opcional)"
        className={inputCls}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={300}
      />
      <input
        aria-label="Escribe BAJA para confirmar"
        placeholder="Escribe BAJA para confirmar"
        className={inputCls}
        value={word}
        onChange={(e) => setWord(e.target.value)}
        autoCapitalize="characters"
      />
      <div className="flex gap-2">
        <SmallButton
          type="submit"
          tone="danger"
          disabled={busy || word.trim().toUpperCase() !== 'BAJA'}
          className="flex-1"
        >
          Dar de baja
        </SmallButton>
        <SmallButton onClick={onCancel} className="flex-1">
          Cancelar
        </SmallButton>
      </div>
    </form>
  );
}
