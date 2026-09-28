/**
 * Panel mínimo: QR y URL NFC de la sucursal, recuperación de tarjeta en el local (semana 3)
 * y caja: dispositivos autorizados, equipo con PIN y PIN del dueño (semana 4).
 * El panel completo (marca, programa, clientes) llega en la semana 5.
 */
import { createClient, type Session } from '@supabase/supabase-js';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { Alert, Button, Page, PoweredBy } from '../components/ui';

const supabase = createClient(
  window.location.origin,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'missing-key',
  {
    auth: { persistSession: true, storageKey: 'aiment.panel.auth' },
  },
);

interface Org {
  id: string;
  name: string;
  role: string;
}
interface LinkRow {
  id: string;
  slug: string;
  branch: string | null;
  qrUrl: string;
  nfcUrl: string;
}
interface CustomerRow {
  id: string;
  fullName: string;
  phone: string;
  membershipId: string | null;
  balance: number | null;
}

export function PanelPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;
    api<{ organizations: Org[] }>('/v1/me', { token: session.access_token })
      .then((r) => {
        setOrgs(r.organizations);
        setOrgId(r.organizations[0]?.id ?? null);
      })
      .catch((e: ApiError) => setError(e.message));
  }, [session]);

  async function login(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const f = new FormData(e.currentTarget);
    const { error: err } = await supabase.auth.signInWithPassword({
      email: String(f.get('email')),
      password: String(f.get('password')),
    });
    if (err) setError('Correo o contraseña incorrectos.');
  }

  if (!session)
    return (
      <Page>
        <h1 className="mt-8 text-2xl font-semibold">Panel de negocios</h1>
        <form className="mt-6 space-y-3" onSubmit={login}>
          <input
            name="email"
            type="email"
            required
            placeholder="Correo"
            autoComplete="username"
            className="h-12 w-full rounded-xl border border-gray-300 bg-white px-3"
          />
          <input
            name="password"
            type="password"
            required
            placeholder="Contraseña"
            autoComplete="current-password"
            className="h-12 w-full rounded-xl border border-gray-300 bg-white px-3"
          />
          {error && <Alert tone="error">{error}</Alert>}
          <Button type="submit">Entrar</Button>
        </form>
        <PoweredBy />
      </Page>
    );

  return (
    <Page>
      <div className="mt-2 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Panel</h1>
        <button className="text-sm underline" onClick={() => void supabase.auth.signOut()}>
          Salir
        </button>
      </div>
      {orgs.length > 1 && (
        <select
          className="mt-3 h-11 w-full rounded-xl border border-gray-300 bg-white px-3"
          value={orgId ?? ''}
          onChange={(e) => setOrgId(e.target.value)}
        >
          {orgs.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      )}
      {error && <Alert tone="error">{error}</Alert>}
      {orgId && <Links orgId={orgId} token={session.access_token} />}
      {orgId && <RegisterAdmin orgId={orgId} token={session.access_token} />}
      {orgId && <InStoreRecovery orgId={orgId} token={session.access_token} />}
      <PoweredBy />
    </Page>
  );
}

function Links({ orgId, token }: { orgId: string; token: string }) {
  const [links, setLinks] = useState<LinkRow[]>([]);
  const [qr, setQr] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    api<{ links: LinkRow[] }>(`/v1/orgs/${orgId}/links`, { token }).then(async (r) => {
      setLinks(r.links);
      const urls: Record<string, string> = {};
      for (const l of r.links) {
        const res = await fetch(`/v1/orgs/${orgId}/links/${l.id}/qr?format=png`, {
          headers: { authorization: `Bearer ${token}` },
        });
        urls[l.id] = URL.createObjectURL(await res.blob());
      }
      setQr(urls);
    });
  }, [orgId, token]);

  return (
    <section className="mt-4 space-y-4">
      <h2 className="text-lg font-semibold">QR y NFC del mostrador</h2>
      {links.map((l) => (
        <div key={l.id} className="rounded-2xl bg-white p-4 shadow-sm">
          <p className="font-medium">{l.branch ?? 'Sucursal'}</p>
          {qr[l.id] && (
            <img src={qr[l.id]} alt={`QR de registro ${l.slug}`} className="mx-auto my-3 h-56 w-56" />
          )}
          <div className="flex gap-2">
            <a
              className="flex-1 rounded-xl bg-gray-900 py-3 text-center text-sm font-semibold text-white"
              href={qr[l.id]}
              download={`qr-${l.slug}.png`}
            >
              Descargar QR
            </a>
            <button
              className="flex-1 rounded-xl border border-gray-300 py-3 text-sm font-semibold"
              onClick={() => void navigator.clipboard?.writeText(l.nfcUrl).then(() => setCopied(l.id))}
            >
              {copied === l.id ? '¡Copiada!' : 'Copiar URL para NFC'}
            </button>
          </div>
          <p className="mt-2 break-all text-xs text-gray-500">NFC: {l.nfcUrl}</p>
          <p className="break-all text-xs text-gray-500">QR: {l.qrUrl}</p>
        </div>
      ))}
    </section>
  );
}

function InStoreRecovery({ orgId, token }: { orgId: string; token: string }) {
  const [results, setResults] = useState<CustomerRow[]>([]);
  const [issued, setIssued] = useState<{ name: string; qrSvg: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function search(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setIssued(null);
    const q = String(new FormData(e.currentTarget).get('q') ?? '').replace(/\s/g, '');
    const r = await api<{ customers: CustomerRow[] }>(
      `/v1/orgs/${orgId}/customers?q=${encodeURIComponent(q)}&limit=5`,
      { token },
    );
    setResults(r.customers);
  }

  async function issue(c: CustomerRow) {
    setError(null);
    try {
      const r = await api<{ qrSvg: string; expiresAt: string }>(
        `/v1/orgs/${orgId}/memberships/${c.membershipId}/recovery`,
        { method: 'POST', token },
      );
      setIssued({ name: c.fullName, ...r });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Error');
    }
  }

  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold">Recuperar tarjeta en el local</h2>
      <p className="text-sm text-gray-600">
        Busca al cliente, verifica que sea él o ella y muéstrale el QR para que lo escanee con su celular.
      </p>
      <form className="mt-3 flex gap-2" onSubmit={search}>
        <input
          name="q"
          required
          placeholder="Celular o nombre"
          className="h-11 flex-1 rounded-xl border border-gray-300 bg-white px-3"
        />
        <button className="rounded-xl bg-gray-900 px-4 text-sm font-semibold text-white">Buscar</button>
      </form>
      <ul className="mt-3 space-y-2">
        {results.map((c) => (
          <li key={c.id} className="flex items-center justify-between rounded-xl bg-white p-3 shadow-sm">
            <span className="text-sm">
              {c.fullName} <span className="text-gray-400">{c.phone}</span>
            </span>
            {c.membershipId && (
              <button className="text-sm font-semibold underline" onClick={() => void issue(c)}>
                QR de recuperación
              </button>
            )}
          </li>
        ))}
      </ul>
      {error && <Alert tone="error">{error}</Alert>}
      {issued && (
        <div className="mt-4 rounded-2xl bg-white p-4 text-center shadow-sm" data-testid="recovery-qr">
          <p className="text-sm font-medium">Para {issued.name}: escanéalo con tu celular</p>
          <div
            className="mx-auto my-3 h-56 w-56 [&>svg]:h-full [&>svg]:w-full"
            dangerouslySetInnerHTML={{ __html: issued.qrSvg }}
          />
          <p className="text-xs text-gray-500">
            Un solo uso · vence {new Date(issued.expiresAt).toLocaleTimeString('es-PE')}
          </p>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Caja: dispositivos y equipo
// ---------------------------------------------------------------------------
interface DeviceRow {
  id: string;
  name: string;
  branch: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  shift: { name: string; since: string } | null;
}
interface TeamRow {
  id: string;
  name: string;
  role: 'owner' | 'admin' | 'staff';
  status: string;
  hasPin: boolean;
  locked: boolean;
  isMe: boolean;
}

const input = 'h-12 w-full rounded-xl border border-gray-300 bg-white px-3';

function RegisterAdmin({ orgId, token }: { orgId: string; token: string }) {
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [team, setTeam] = useState<TeamRow[]>([]);
  const [pairing, setPairing] = useState<{ url: string; qrSvg: string; expiresAt: string } | null>(null);
  const [pinFor, setPinFor] = useState<TeamRow | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(() => {
    void api<{ devices: DeviceRow[] }>(`/v1/orgs/${orgId}/devices`, { token })
      .then((r) => setDevices(r.devices))
      .catch(() => setDevices([]));
    void api<{ team: TeamRow[] }>(`/v1/orgs/${orgId}/team`, { token }).then((r) => setTeam(r.team));
  }, [orgId, token]);
  useEffect(load, [load]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: 'ok', text: ok });
      load();
      return true;
    } catch (e) {
      setMsg({ tone: 'error', text: e instanceof ApiError ? e.message : 'Error' });
      return false;
    }
  };

  async function authorize(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get('name') ?? '');
    setMsg(null);
    try {
      setPairing(await api(`/v1/orgs/${orgId}/devices/pairings`, { method: 'POST', token, json: { name } }));
    } catch (err) {
      setMsg({ tone: 'error', text: err instanceof ApiError ? err.message : 'Error' });
    }
  }

  async function addStaff(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const ok = await act(
      () =>
        api(`/v1/orgs/${orgId}/team`, {
          method: 'POST',
          token,
          json: { name: String(f.get('name') ?? ''), pin: String(f.get('pin') ?? '') },
        }),
      'Trabajador agregado. Ya puede entrar a la caja con su PIN.',
    );
    if (ok) form.reset();
  }

  async function changePin(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const pin = String(new FormData(e.currentTarget).get('pin') ?? '');
    const ok = await act(
      () => api(`/v1/orgs/${orgId}/team/${pinFor!.id}/pin`, { method: 'POST', token, json: { pin } }),
      `PIN actualizado para ${pinFor!.name}.`,
    );
    if (ok) setPinFor(null);
  }

  const roleName = { owner: 'Dueño', admin: 'Admin', staff: 'Caja' } as const;
  const me = team.find((t) => t.isMe);

  return (
    <section className="mt-8 space-y-4" data-testid="register-admin">
      <h2 className="text-lg font-semibold">Caja</h2>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}

      <div className="rounded-2xl bg-white p-4 shadow-sm">
        <p className="font-medium">Autorizar un dispositivo de caja</p>
        <p className="text-sm text-gray-600">
          Genera un QR de un solo uso (vence en 10 minutos) y escanéalo con el celular o tablet de la caja.
        </p>
        <form className="mt-3 flex gap-2" onSubmit={authorize}>
          <input
            name="name"
            required
            placeholder="Ej.: Celular del mostrador"
            maxLength={40}
            className={input}
          />
          <button className="shrink-0 rounded-xl bg-gray-900 px-4 text-sm font-semibold text-white">
            Generar QR
          </button>
        </form>
        {pairing && (
          <div className="mt-4 text-center" data-testid="pairing-qr">
            <div
              className="mx-auto h-56 w-56 [&>svg]:h-full [&>svg]:w-full"
              dangerouslySetInnerHTML={{ __html: pairing.qrSvg }}
            />
            <p className="mt-2 text-xs text-gray-500">
              Un solo uso · vence {new Date(pairing.expiresAt).toLocaleTimeString('es-PE')}
            </p>
            <a href={pairing.url} className="mt-2 inline-block text-sm font-semibold underline">
              Usar ESTE dispositivo como caja
            </a>
          </div>
        )}
      </div>

      {devices.length > 0 && (
        <ul className="space-y-2">
          {devices.map((d) => (
            <li
              key={d.id}
              className="flex items-center justify-between gap-2 rounded-xl bg-white p-3 text-sm shadow-sm"
            >
              <span className={d.revokedAt ? 'text-gray-400 line-through' : ''}>
                <strong>{d.name}</strong> · {d.branch}
                <span className="block text-xs text-gray-500">
                  {d.revokedAt
                    ? 'Revocado'
                    : d.shift
                      ? `De turno: ${d.shift.name}`
                      : d.lastSeenAt
                        ? `Último uso: ${new Date(d.lastSeenAt).toLocaleString('es-PE')}`
                        : 'Sin uso'}
                </span>
              </span>
              {!d.revokedAt && (
                <button
                  className="shrink-0 rounded-lg px-3 py-2 font-semibold text-red-700 ring-1 ring-red-200"
                  onClick={() =>
                    void act(
                      () => api(`/v1/orgs/${orgId}/devices/${d.id}/revoke`, { method: 'POST', token }),
                      `"${d.name}" ya no puede usarse como caja.`,
                    )
                  }
                >
                  Revocar
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="rounded-2xl bg-white p-4 shadow-sm">
        <p className="font-medium">Equipo de caja</p>
        <ul className="mt-2 divide-y divide-gray-100 text-sm">
          {team
            .filter((t) => t.status === 'active')
            .map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-2 py-2">
                <span>
                  {t.name} <span className="text-gray-400">· {roleName[t.role]}</span>
                  <span className="block text-xs text-gray-500">
                    {t.locked
                      ? 'Bloqueado por intentos (cambia su PIN para desbloquear)'
                      : t.hasPin
                        ? 'Con PIN'
                        : 'Sin PIN'}
                  </span>
                </span>
                {(t.role === 'staff' || t.isMe) && (
                  <span className="flex shrink-0 gap-2">
                    <button
                      className="rounded-lg px-2 py-2 font-semibold underline"
                      onClick={() => setPinFor(t)}
                    >
                      {t.hasPin ? 'Cambiar PIN' : 'Poner PIN'}
                    </button>
                    {t.role === 'staff' && (
                      <button
                        className="rounded-lg px-2 py-2 text-red-700 underline"
                        onClick={() =>
                          void act(
                            () => api(`/v1/orgs/${orgId}/team/${t.id}/deactivate`, { method: 'POST', token }),
                            `${t.name} ya no puede entrar a la caja.`,
                          )
                        }
                      >
                        Dar de baja
                      </button>
                    )}
                  </span>
                )}
              </li>
            ))}
        </ul>
        {pinFor && (
          <form className="mt-3 space-y-2 rounded-xl bg-gray-50 p-3" onSubmit={changePin}>
            <p className="text-sm font-medium">
              Nuevo PIN para {pinFor.name}
              {pinFor.isMe && ' (con él autorizas excepciones en caja)'}
            </p>
            <input
              name="pin"
              required
              inputMode="numeric"
              pattern="[0-9]{4,6}"
              maxLength={6}
              placeholder="4 a 6 números"
              className={input}
            />
            <div className="flex gap-2">
              <button className="flex-1 rounded-xl bg-gray-900 py-3 text-sm font-semibold text-white">
                Guardar
              </button>
              <button
                type="button"
                className="flex-1 rounded-xl py-3 text-sm ring-1 ring-gray-300"
                onClick={() => setPinFor(null)}
              >
                Cancelar
              </button>
            </div>
          </form>
        )}
        <form className="mt-4 space-y-2" onSubmit={addStaff}>
          <p className="text-sm font-medium">Agregar trabajador</p>
          <input name="name" required placeholder="Nombre" maxLength={40} className={input} />
          <input
            name="pin"
            required
            inputMode="numeric"
            pattern="[0-9]{4,6}"
            maxLength={6}
            placeholder="PIN (4 a 6 números)"
            className={input}
          />
          <Button type="submit">Agregar</Button>
        </form>
        {me && !me.hasPin && (
          <p className="mt-3 text-xs text-amber-700">
            Define tu PIN: lo necesitas para autorizar en caja una excepción (por ejemplo, sumar dos veces el
            mismo día).
          </p>
        )}
      </div>
    </section>
  );
}
