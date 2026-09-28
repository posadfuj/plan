/**
 * Caja (semana 4): se usa con una mano, en un celular de gama media, con botones grandes (≥ 56 px).
 * 1. El dispositivo se autoriza una vez con el QR del dueño (/caja/vincular/...).
 * 2. Cada turno: elegir el nombre y escribir el PIN.
 * 3. ESCANEAR CLIENTE (o buscar por celular/código) → ficha → sumar, canjear o anular.
 */
import { useNavigate, useParams } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  api,
  ApiError,
  newIdempotencyKey,
  type CashierOperation,
  type CashierView,
  type RegisterDevice,
} from '../api';
import { Alert, Page, PoweredBy, Spinner } from '../components/ui';
import { Scanner, scanTokenFrom, warmUpScanner } from '../components/scanner';

const LIMIT_CODES = new Set([
  'cooldown_active',
  'max_units_per_tx',
  'max_amount_per_tx',
  'staff_daily_units',
]);

function BigButton({
  children,
  tone = 'dark',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'dark' | 'green' | 'light' | 'red' }) {
  const cls = {
    dark: 'bg-gray-900 text-white',
    green: 'bg-emerald-600 text-white',
    light: 'bg-white text-gray-900 ring-1 ring-gray-300',
    red: 'bg-white text-red-700 ring-1 ring-red-300',
  }[tone];
  return (
    <button
      {...props}
      className={`min-h-14 w-full rounded-2xl px-4 text-lg font-semibold active:scale-[.99] disabled:opacity-50 ${cls} ${className}`}
    >
      {children}
    </button>
  );
}

/** Teclado numérico grande para el PIN (4 a 6 dígitos). */
function PinPad({
  title,
  onSubmit,
  busy,
  error,
  onCancel,
  submitLabel = 'Entrar',
}: {
  title: ReactNode;
  onSubmit: (pin: string) => void;
  busy: boolean;
  error: string | null;
  onCancel?: () => void;
  submitLabel?: string;
}) {
  const [pin, setPin] = useState('');
  useEffect(() => {
    if (error) setPin('');
  }, [error]);
  const press = (d: string) => setPin((p) => (p.length < 6 ? p + d : p));
  return (
    <div className="space-y-4" data-testid="pinpad">
      <p className="text-center text-lg font-medium">{title}</p>
      <div className="flex justify-center gap-3" aria-label={`${pin.length} dígitos`}>
        {Array.from({ length: Math.max(4, pin.length) }, (_, i) => (
          <span
            key={i}
            className={`h-4 w-4 rounded-full ${i < pin.length ? 'bg-gray-900' : 'bg-gray-300'}`}
          />
        ))}
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      <div className="grid grid-cols-3 gap-3">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => press(d)}
            className="min-h-16 rounded-2xl bg-white text-2xl font-semibold shadow-sm ring-1 ring-gray-200 active:bg-gray-100"
          >
            {d}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setPin((p) => p.slice(0, -1))}
          className="min-h-16 rounded-2xl text-base text-gray-600 active:bg-gray-100"
        >
          Borrar
        </button>
        <button
          type="button"
          onClick={() => press('0')}
          className="min-h-16 rounded-2xl bg-white text-2xl font-semibold shadow-sm ring-1 ring-gray-200 active:bg-gray-100"
        >
          0
        </button>
        <button
          type="button"
          disabled={pin.length < 4 || busy}
          onClick={() => onSubmit(pin)}
          className="min-h-16 rounded-2xl bg-gray-900 text-base font-semibold text-white disabled:opacity-40"
        >
          {busy ? '…' : submitLabel}
        </button>
      </div>
      {onCancel && (
        <button type="button" onClick={onCancel} className="w-full py-3 text-base underline">
          Volver
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Autorización del dispositivo (/caja/vincular/$code)
// ---------------------------------------------------------------------------
export function PairDevicePage() {
  const { code } = useParams({ strict: false }) as { code: string };
  const navigate = useNavigate();
  const [state, setState] = useState<{ ok: boolean; message: string } | null>(null);
  const once = useRef(false);

  useEffect(() => {
    if (once.current) return; // StrictMode monta dos veces: el código es de un solo uso
    once.current = true;
    api<{ device: { name: string } }>('/v1/staff/device/pair', { method: 'POST', json: { code } })
      .then((r) => {
        setState({ ok: true, message: `Listo: este dispositivo quedó autorizado como "${r.device.name}".` });
        setTimeout(() => void navigate({ to: '/caja', replace: true }), 1200);
      })
      .catch((e: ApiError) => setState({ ok: false, message: e.message }));
  }, [code, navigate]);

  return (
    <Page>
      <h1 className="mt-10 text-2xl font-semibold">Autorizar caja</h1>
      <div className="mt-6">
        {state ? <Alert tone={state.ok ? 'ok' : 'error'}>{state.message}</Alert> : <Spinner />}
      </div>
      <PoweredBy />
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Caja (/caja)
// ---------------------------------------------------------------------------
export function CajaPage() {
  const [device, setDevice] = useState<RegisterDevice | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(() => {
    setError(null);
    return api<RegisterDevice>('/v1/staff/device')
      .then(setDevice)
      .catch((e: ApiError) => setError(e));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (error?.code === 'device_not_authorized')
    return (
      <Page>
        <h1 className="mt-10 text-2xl font-semibold">Caja</h1>
        <div className="mt-6" data-testid="device-not-authorized">
          <Alert tone="info">
            Este dispositivo todavía no está autorizado como caja. Pide al dueño que lo autorice desde su
            panel (Cajas → Generar QR) y escanea el QR con este celular.
          </Alert>
        </div>
        <PoweredBy />
      </Page>
    );
  if (error)
    return (
      <Page>
        <div className="mt-10 space-y-4">
          <Alert tone="error">{error.message}</Alert>
          <BigButton onClick={() => void load()}>Reintentar</BigButton>
        </div>
      </Page>
    );
  if (!device) return <Spinner />;
  return (
    <>
      <OfflineBanner />
      {device.shift ? (
        <Register device={device} onShiftEnded={load} />
      ) : (
        <Login device={device} onDone={load} />
      )}
    </>
  );
}

/**
 * La caja necesita conexión (no hay modo sin conexión en el MVP: ADR 0004). Si el celular pierde la red,
 * se avisa de inmediato para que nadie crea que sumó una visita que no llegó al servidor.
 */
function OfflineBanner() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  if (online) return null;
  return (
    <div
      role="alert"
      data-testid="offline-banner"
      className="sticky top-0 z-20 bg-red-700 px-4 py-3 text-center text-white"
    >
      <p className="font-semibold">Sin conexión a internet</p>
      <p className="text-sm">
        La caja no puede sumar ni canjear hasta que vuelva la señal. Nada se registra sin conexión.
      </p>
    </div>
  );
}

function Login({ device, onDone }: { device: RegisterDevice; onDone: () => Promise<void> }) {
  const [person, setPerson] = useState<RegisterDevice['people'][number] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(pin: string) {
    setBusy(true);
    setError(null);
    try {
      await api('/v1/staff/shift', { method: 'POST', json: { personId: person!.id, pin } });
      await onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'No se pudo entrar');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page>
      <header className="mt-4">
        <p className="text-sm text-gray-500">
          {device.device.name} · {device.device.branch}
        </p>
        <h1 className="text-2xl font-semibold">{device.organization.name}</h1>
      </header>
      {!person ? (
        <section className="mt-6 space-y-3">
          <p className="text-lg font-medium">¿Quién atiende?</p>
          {device.people.map((p) => (
            <BigButton key={p.id} tone="light" onClick={() => setPerson(p)} className="text-left">
              {p.name}
              {p.role !== 'staff' && (
                <span className="ml-2 text-sm font-normal text-gray-500">
                  ({p.role === 'owner' ? 'dueño' : 'admin'})
                </span>
              )}
            </BigButton>
          ))}
          {device.people.length === 0 && (
            <Alert tone="info">Nadie tiene PIN todavía. El dueño lo define en su panel (Equipo).</Alert>
          )}
        </section>
      ) : (
        <section className="mt-6">
          <PinPad
            title={
              <>
                Hola, <strong>{person.name}</strong>. Escribe tu PIN
              </>
            }
            busy={busy}
            error={error}
            onSubmit={(pin) => void submit(pin)}
            onCancel={() => {
              setPerson(null);
              setError(null);
            }}
          />
        </section>
      )}
      <PoweredBy />
    </Page>
  );
}

type Feedback = { tone: 'ok' | 'error' | 'info'; text: string };

/** "1 sello", "2 sellos", "1 punto". */
const units = (n: number, label: string) =>
  `${n} ${Math.abs(n) === 1 && label.endsWith('s') ? label.slice(0, -1) : label}`;

function describe(op: CashierOperation): string {
  const v = op.view;
  const unit = v.program.unitLabel;
  const parts: string[] = [];
  if (op.operation === 'earn') {
    const earned = op.entries.filter((e) => e.kind === 'earn').reduce((s, e) => s + e.delta, 0);
    const bonus = op.entries.filter((e) => e.kind === 'bonus').reduce((s, e) => s + e.delta, 0);
    parts.push(`+${units(earned, unit)}`);
    if (bonus) parts.push(`bono de bienvenida +${bonus}`);
    if (op.earnedRewards.length)
      parts.push(`¡premio ganado: ${op.earnedRewards.map((r) => r.name).join(', ')}!`);
  } else if (op.operation === 'redeem') parts.push('Premio canjeado');
  else parts.push('Anulado');
  if (op.replayed) parts.push('(ya estaba registrado)');
  return parts.join(' · ');
}

function Register({ device, onShiftEnded }: { device: RegisterDevice; onShiftEnded: () => Promise<void> }) {
  const [scanning, setScanning] = useState(false);
  const [view, setView] = useState<CashierView | null>(null);
  const [results, setResults] = useState<
    { membershipId: string; name: string; phone: string | null; shortCode: string }[] | null
  >(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(warmUpScanner, []);

  const handleAuthError = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && (e.code === 'shift_required' || e.code === 'device_not_authorized')) {
        void onShiftEnded();
        return true;
      }
      return false;
    },
    [onShiftEnded],
  );

  const open = useCallback(
    async (path: string) => {
      setBusy(true);
      setFeedback(null);
      setResults(null);
      try {
        setView(await api<CashierView>(path));
      } catch (e) {
        if (!handleAuthError(e))
          setFeedback({ tone: 'error', text: e instanceof ApiError ? e.message : 'No se pudo abrir' });
      } finally {
        setBusy(false);
      }
    },
    [handleAuthError],
  );

  const onScan = useCallback(
    (text: string) => {
      setScanning(false);
      const token = scanTokenFrom(text);
      if (!token) {
        setFeedback({
          tone: 'error',
          text: 'Ese QR no es una tarjeta de cliente. Pide que abra su tarjeta.',
        });
        return;
      }
      void open(`/v1/staff/scan/${token}`);
    },
    [open],
  );

  async function search(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = String(new FormData(e.currentTarget).get('q') ?? '').trim();
    if (!q) return;
    setFeedback(null);
    setView(null);
    try {
      const r = await api<{ results: NonNullable<typeof results> }>(
        `/v1/staff/memberships?q=${encodeURIComponent(q)}`,
      );
      setResults(r.results);
      if (r.results.length === 1) void open(`/v1/staff/memberships/${r.results[0]!.membershipId}`);
    } catch (err) {
      if (!handleAuthError(err))
        setFeedback({ tone: 'error', text: err instanceof ApiError ? err.message : 'Error al buscar' });
    }
  }

  async function endShift() {
    await api('/v1/staff/shift', { method: 'DELETE' }).catch(() => undefined);
    await onShiftEnded();
  }

  return (
    <Page>
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm text-gray-500">{device.organization.name}</p>
          <p className="truncate font-semibold" data-testid="shift-name">
            Turno: {device.shift!.name}
          </p>
        </div>
        <button
          onClick={() => void endShift()}
          className="min-h-11 shrink-0 rounded-xl px-3 text-sm underline"
        >
          Cerrar turno
        </button>
      </header>

      {feedback && (
        <div className="mt-3" data-testid="feedback">
          <Alert tone={feedback.tone}>{feedback.text}</Alert>
        </div>
      )}

      {view ? (
        <Customer
          view={view}
          role={device.shift!.role}
          busy={busy}
          setBusy={setBusy}
          onUpdate={(v, fb) => {
            setView(v);
            setFeedback(fb);
          }}
          onError={(e) => {
            if (!handleAuthError(e))
              setFeedback({ tone: 'error', text: e instanceof ApiError ? e.message : 'Ocurrió un error' });
          }}
          onClose={() => {
            setView(null);
            setFeedback(null);
          }}
          onScanNext={() => {
            setView(null);
            setFeedback(null);
            setScanning(true);
          }}
        />
      ) : (
        <section className="mt-6 space-y-5">
          <button
            onClick={() => setScanning(true)}
            disabled={busy}
            className="flex min-h-40 w-full flex-col items-center justify-center rounded-3xl bg-gray-900 text-2xl font-bold tracking-wide text-white shadow-lg active:scale-[.99]"
          >
            <span aria-hidden className="text-5xl">
              ⌗
            </span>
            ESCANEAR CLIENTE
          </button>
          <form onSubmit={search} className="space-y-3">
            <label className="block">
              <span className="text-sm font-medium">O busca por celular o código de la tarjeta</span>
              <input
                name="q"
                inputMode="text"
                autoComplete="off"
                placeholder="987 654 321 o ABC234"
                className="mt-1 h-14 w-full rounded-2xl border border-gray-300 bg-white px-4 text-lg"
              />
            </label>
            <BigButton type="submit" tone="light">
              Buscar
            </BigButton>
          </form>
          {results && results.length === 0 && (
            <Alert tone="info">No encontramos ese cliente en este negocio.</Alert>
          )}
          {results && results.length > 1 && (
            <ul className="space-y-2">
              {results.map((r) => (
                <li key={r.membershipId}>
                  <BigButton
                    tone="light"
                    onClick={() => void open(`/v1/staff/memberships/${r.membershipId}`)}
                  >
                    {r.name} <span className="text-sm font-normal text-gray-500">{r.phone}</span>
                  </BigButton>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {scanning && <Scanner onResult={onScan} onCancel={() => setScanning(false)} />}
      <PoweredBy />
    </Page>
  );
}

function Customer({
  view,
  role,
  busy,
  setBusy,
  onUpdate,
  onError,
  onClose,
  onScanNext,
}: {
  view: CashierView;
  role: 'owner' | 'admin' | 'staff';
  busy: boolean;
  setBusy: (b: boolean) => void;
  onUpdate: (v: CashierView, fb: Feedback) => void;
  onError: (e: unknown) => void;
  onClose: () => void;
  onScanNext: () => void;
}) {
  const isStamps = view.program.mode === 'stamps';
  const blocked = view.status === 'blocked';
  const [amount, setAmount] = useState('');
  const [limit, setLimit] = useState<{ message: string; amount: string | null } | null>(null);
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const [voiding, setVoiding] = useState<CashierView['activity'][number] | null>(null);
  const [confirmRedeem, setConfirmRedeem] = useState<{ label: string; body: Record<string, string> } | null>(
    null,
  );
  const [recovery, setRecovery] = useState<{ qrSvg: string; expiresAt: string } | null>(null);
  const [retry, setRetry] = useState<(() => void) | null>(null);
  const canAuthorize = role !== 'staff';

  /** Ejecuta una operación; si falla por red, ofrece reintentar con la MISMA clave (no duplica). */
  async function run(path: string, body: unknown, key = newIdempotencyKey()) {
    setBusy(true);
    setRetry(null);
    try {
      const op = await api<CashierOperation>(path, { method: 'POST', json: body, idempotencyKey: key });
      setLimit(null);
      setOverrideError(null);
      setAmount('');
      onUpdate(op.view, { tone: 'ok', text: describe(op) });
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) {
        setRetry(() => () => void run(path, body, key));
        onError(e);
      } else if (e instanceof ApiError && LIMIT_CODES.has(e.code)) {
        setLimit({ message: e.message, amount: isStamps ? null : amount });
      } else if (e instanceof ApiError && e.code === 'invalid_override_pin') {
        setOverrideError(e.message);
      } else onError(e);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const earn = (override?: { reason: string; pin?: string }) =>
    run(`/v1/staff/memberships/${view.membershipId}/earn`, {
      ...(isStamps ? {} : { amount: (limit?.amount ?? amount).replace(',', '.') }),
      ...(override ? { override } : {}),
    });

  return (
    <section className="mt-4 space-y-4" data-testid="customer">
      <div className="rounded-2xl bg-white p-5 shadow-sm">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-xl font-semibold" data-testid="customer-name">
              {view.customer.name}
            </p>
            <p className="text-sm text-gray-500">
              {view.customer.phone} · {view.shortCode}
            </p>
          </div>
          <button onClick={onClose} className="min-h-11 px-2 text-sm underline">
            Cerrar
          </button>
        </div>
        <p className="mt-3 text-4xl font-bold" data-testid="cashier-balance">
          {view.balance} <span className="text-lg font-medium text-gray-500">{view.program.unitLabel}</span>
        </p>
        {isStamps && view.program.goal && (
          <p className="text-sm text-gray-600" data-testid="cashier-progress">
            {view.balance} de {view.program.goal} para el premio
          </p>
        )}
        {view.firstVisit && <p className="mt-1 text-sm font-medium text-emerald-700">Primera visita</p>}
      </div>

      {blocked && (
        <div className="rounded-2xl bg-red-50 p-4 text-red-800" role="alert" data-testid="customer-blocked">
          <p className="font-semibold">Cliente bloqueado por el negocio</p>
          <p className="text-sm">
            No se puede sumar ni canjear. Si hay un error, que el dueño lo desbloquee desde su panel.
          </p>
        </div>
      )}

      {!limit &&
        !blocked &&
        (isStamps ? (
          <BigButton tone="green" disabled={busy} onClick={() => void earn()} data-testid="earn">
            {busy ? 'Registrando…' : 'SUMAR VISITA'}
          </BigButton>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void earn();
            }}
          >
            <label className="block">
              <span className="text-sm font-medium">Importe de la compra (S/)</span>
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
                placeholder="0.00"
                className="mt-1 h-14 w-full rounded-2xl border border-gray-300 bg-white px-4 text-2xl"
                data-testid="amount"
              />
            </label>
            <BigButton tone="green" type="submit" disabled={busy || !amount} data-testid="earn">
              {busy ? 'Registrando…' : `SUMAR ${view.program.unitLabel.toUpperCase()}`}
            </BigButton>
          </form>
        ))}

      {retry && (
        <BigButton tone="light" onClick={retry}>
          Reintentar (no se duplica)
        </BigButton>
      )}

      {limit && (
        <div className="space-y-3 rounded-2xl bg-amber-50 p-4" data-testid="limit">
          <p className="font-semibold text-amber-900">{limit.message}</p>
          <OverrideForm
            needsPin={!canAuthorize}
            busy={busy}
            error={overrideError}
            onSubmit={(o) => void earn(o)}
            onCancel={() => {
              setLimit(null);
              setOverrideError(null);
            }}
          />
        </div>
      )}

      {!blocked && view.availableRewards.length > 0 && (
        <div className="space-y-2">
          <p className="font-semibold">Premios para canjear</p>
          {view.availableRewards.map((r) => (
            <BigButton
              key={r.id}
              tone="light"
              disabled={busy}
              onClick={() => setConfirmRedeem({ label: r.name, body: { earnedRewardId: r.id } })}
            >
              Canjear: {r.name}
            </BigButton>
          ))}
        </div>
      )}
      {!blocked && view.catalog.some((r) => r.affordable) && (
        <div className="space-y-2">
          <p className="font-semibold">Puede canjear</p>
          {view.catalog
            .filter((r) => r.affordable)
            .map((r) => (
              <BigButton
                key={r.id}
                tone="light"
                disabled={busy}
                onClick={() => setConfirmRedeem({ label: r.name, body: { rewardId: r.id } })}
              >
                {r.name} · {r.cost} {view.program.unitLabel}
              </BigButton>
            ))}
        </div>
      )}
      {confirmRedeem && (
        <div
          className="space-y-3 rounded-2xl bg-white p-4 shadow-sm ring-2 ring-gray-900"
          data-testid="confirm-redeem"
        >
          <p className="text-lg">
            ¿Entregar <strong>{confirmRedeem.label}</strong> a {view.customer.name}?
          </p>
          <div className="grid grid-cols-2 gap-3">
            <BigButton tone="light" onClick={() => setConfirmRedeem(null)}>
              No
            </BigButton>
            <BigButton
              tone="green"
              disabled={busy}
              onClick={() =>
                void run(`/v1/staff/memberships/${view.membershipId}/redeem`, confirmRedeem.body).then(() =>
                  setConfirmRedeem(null),
                )
              }
            >
              Sí, canjear
            </BigButton>
          </div>
        </div>
      )}

      {view.activity.length > 0 && (
        <div className="rounded-2xl bg-white p-4 shadow-sm">
          <p className="mb-2 text-sm font-semibold">Últimos movimientos</p>
          <ul className="divide-y divide-gray-100">
            {view.activity.map((a) => (
              <li key={a.id} className="flex min-h-14 items-center justify-between gap-2 py-2 text-sm">
                <span className={a.voided ? 'text-gray-400 line-through' : ''}>
                  {activityLabel(a, view.program.unitLabel)}
                  <span className="block text-xs text-gray-400">
                    {new Date(a.at).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })}
                    {a.by ? ` · ${a.by}` : ''}
                  </span>
                </span>
                {a.canVoid && (
                  <button
                    onClick={() => setVoiding(a)}
                    className="min-h-11 shrink-0 rounded-xl px-3 font-semibold text-red-700 ring-1 ring-red-200"
                  >
                    Anular
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {voiding && (
        <VoidForm
          busy={busy}
          onCancel={() => setVoiding(null)}
          onSubmit={(reason) =>
            void run(
              voiding.type === 'entry'
                ? `/v1/staff/ledger/${voiding.id}/void`
                : `/v1/staff/redemptions/${voiding.id}/void`,
              { reason },
            ).then((ok) => ok && setVoiding(null))
          }
        />
      )}

      <BigButton onClick={onScanNext}>Siguiente cliente</BigButton>

      <div className="pt-2 text-center">
        {!recovery ? (
          <button
            className="min-h-11 text-sm underline"
            onClick={() =>
              void api<{ qrSvg: string; expiresAt: string }>(
                `/v1/staff/memberships/${view.membershipId}/recovery`,
                {
                  method: 'POST',
                },
              )
                .then(setRecovery)
                .catch(onError)
            }
          >
            El cliente perdió su tarjeta: QR de recuperación
          </button>
        ) : (
          <div className="rounded-2xl bg-white p-4 shadow-sm" data-testid="recovery-qr">
            <p className="text-sm font-medium">
              Verifica que sea {view.customer.name} y que lo escanee con su celular
            </p>
            <div
              className="mx-auto my-3 h-56 w-56 [&>svg]:h-full [&>svg]:w-full"
              dangerouslySetInnerHTML={{ __html: recovery.qrSvg }}
            />
            <p className="text-xs text-gray-500">
              Un solo uso · vence {new Date(recovery.expiresAt).toLocaleTimeString('es-PE')}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

function activityLabel(a: CashierView['activity'][number], unit: string): string {
  if (a.type === 'redemption') return `Canje: ${a.label}${a.voided ? ' (anulado)' : ''}`;
  const sign = a.delta > 0 ? '+' : '';
  const names: Record<string, string> = {
    earn: 'Visita / compra',
    bonus: 'Bono de bienvenida',
    redeem: 'Canje',
    adjust: 'Ajuste',
    reversal: 'Anulación',
  };
  return `${names[a.kind] ?? a.kind} ${sign}${a.delta} ${unit}${a.voided ? ' (anulado)' : ''}`;
}

const VOID_REASONS = ['Me equivoqué de cliente', 'Registré de más', 'El cliente no compró'];

function VoidForm({
  busy,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  onSubmit: (reason: string) => void;
  onCancel: () => void;
}) {
  const [other, setOther] = useState('');
  return (
    <div className="space-y-2 rounded-2xl bg-white p-4 shadow-sm ring-2 ring-red-300" data-testid="void-form">
      <p className="font-semibold">¿Por qué lo anulas?</p>
      {VOID_REASONS.map((r) => (
        <BigButton key={r} tone="light" disabled={busy} onClick={() => onSubmit(r)}>
          {r}
        </BigButton>
      ))}
      <input
        value={other}
        onChange={(e) => setOther(e.target.value)}
        placeholder="Otro motivo"
        maxLength={300}
        className="h-14 w-full rounded-2xl border border-gray-300 px-4 text-base"
      />
      <div className="grid grid-cols-2 gap-3">
        <BigButton tone="light" onClick={onCancel}>
          Volver
        </BigButton>
        <BigButton
          tone="red"
          disabled={busy || other.trim().length < 3}
          onClick={() => onSubmit(other.trim())}
        >
          Anular
        </BigButton>
      </div>
    </div>
  );
}

/** Excepción de límite: motivo + PIN del dueño o de un admin (si quien atiende es trabajador). */
function OverrideForm({
  needsPin,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  needsPin: boolean;
  busy: boolean;
  error: string | null;
  onSubmit: (o: { reason: string; pin?: string }) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const ready = reason.trim().length >= 5;
  return (
    <div className="space-y-3">
      <label className="block">
        <span className="text-sm font-medium">Motivo de la excepción</span>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Ej.: vino dos veces hoy"
          maxLength={300}
          className="mt-1 h-14 w-full rounded-2xl border border-gray-300 bg-white px-4 text-base"
          data-testid="override-reason"
        />
      </label>
      {needsPin ? (
        ready ? (
          <PinPad
            title="PIN del dueño o de un administrador"
            submitLabel="Autorizar"
            busy={busy}
            error={error}
            onSubmit={(pin) => onSubmit({ reason: reason.trim(), pin })}
            onCancel={onCancel}
          />
        ) : (
          <BigButton tone="light" onClick={onCancel}>
            No sumar
          </BigButton>
        )
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <BigButton tone="light" onClick={onCancel}>
            No sumar
          </BigButton>
          <BigButton
            tone="green"
            disabled={!ready || busy}
            onClick={() => onSubmit({ reason: reason.trim() })}
          >
            Autorizar
          </BigButton>
        </div>
      )}
    </div>
  );
}
