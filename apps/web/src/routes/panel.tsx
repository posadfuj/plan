/**
 * Panel mínimo (semana 3): QR y URL NFC de la sucursal, y recuperación de tarjeta en el local.
 * El panel completo (marca, programa, clientes) llega en la semana 5.
 */
import { createClient, type Session } from '@supabase/supabase-js';
import { useEffect, useState, type FormEvent } from 'react';
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
