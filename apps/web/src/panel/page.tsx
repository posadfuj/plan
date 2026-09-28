/**
 * Panel del dueño (semana 5). Todo lo que un negocio necesita configurar y administrar sin tocar código:
 * marca, programa, clientes, equipo con sucursal, cajas autorizadas y sucursales, dentro de su plan.
 * Pensado primero para el celular del dueño; en computadora se aprovecha el ancho.
 */
import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent } from 'react';
import { api, type ApiError } from '../api';
import { Alert, Button, PoweredBy, Spinner } from '../components/ui';
import { BranchesSection } from './branches';
import { BrandSection } from './brand';
import { CustomersSection } from './customers';
import { DevicesSection } from './devices';
import { HomeSection } from './home';
import { ProgramSection } from './program';
import {
  Badge,
  inputCls,
  PanelProvider,
  STATUS_LABEL,
  supabase,
  usePanel,
  useSession,
  type Role,
} from './shared';
import { TeamSection } from './team';

export const SECTIONS = [
  { key: 'inicio', label: 'Inicio', Component: HomeSection },
  { key: 'marca', label: 'Marca', Component: BrandSection },
  { key: 'programa', label: 'Programa', Component: ProgramSection },
  { key: 'clientes', label: 'Clientes', Component: CustomersSection },
  { key: 'equipo', label: 'Equipo', Component: TeamSection },
  { key: 'cajas', label: 'Cajas', Component: DevicesSection },
  { key: 'sucursales', label: 'Sucursales', Component: BranchesSection },
] as const;
export type SectionKey = (typeof SECTIONS)[number]['key'];

interface Org {
  id: string;
  name: string;
  role: Role;
  status: string;
}

const ORG_KEY = 'aiment.panel.org';

export function LoginForm({ title, error: initialError }: { title: string; error?: string | null }) {
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [busy, setBusy] = useState(false);
  async function login(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const f = new FormData(e.currentTarget);
    const { error: err } = await supabase.auth.signInWithPassword({
      email: String(f.get('email')).trim(),
      password: String(f.get('password')),
    });
    setBusy(false);
    if (err)
      setError(err.status === 0 ? 'Sin conexión. Revisa tu internet.' : 'Correo o contraseña incorrectos.');
  }
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-4 pb-8 pt-4">
      <h1 className="mt-8 text-2xl font-semibold">{title}</h1>
      <form className="mt-6 space-y-3" onSubmit={login}>
        <input
          name="email"
          type="email"
          required
          placeholder="Correo"
          autoComplete="username"
          className={inputCls}
        />
        <input
          name="password"
          type="password"
          required
          placeholder="Contraseña"
          autoComplete="current-password"
          className={inputCls}
        />
        {error && <Alert tone="error">{error}</Alert>}
        <Button type="submit" disabled={busy}>
          {busy ? 'Entrando…' : 'Entrar'}
        </Button>
      </form>
      <PoweredBy />
    </main>
  );
}

export function PanelPage() {
  const session = useSession();
  const params = useParams({ strict: false }) as { section?: string };
  const section = (SECTIONS.find((s) => s.key === params.section)?.key ?? 'inicio') as SectionKey;
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    api<{ organizations: Org[] }>('/v1/me', { token: session.access_token })
      .then((r) => {
        setOrgs(r.organizations);
        let saved: string | null = null;
        try {
          saved = localStorage.getItem(ORG_KEY);
        } catch {
          /* almacenamiento bloqueado */
        }
        setOrgId(r.organizations.find((o) => o.id === saved)?.id ?? r.organizations[0]?.id ?? null);
      })
      .catch((e: ApiError) => setError(e.message));
    // Solo al cambiar de usuario (el token se renueva solo cada hora).
  }, [session?.user.id]);

  if (session === undefined) return <Spinner />;
  if (!session) return <LoginForm title="Panel de negocios" />;
  if (error)
    return (
      <main className="mx-auto max-w-md px-4 pt-8">
        <Alert tone="error">{error}</Alert>
        <button className="mt-4 text-sm underline" onClick={() => void supabase.auth.signOut()}>
          Salir
        </button>
      </main>
    );
  if (!orgs) return <Spinner />;
  const org = orgs.find((o) => o.id === orgId);
  if (!org)
    return (
      <main className="mx-auto max-w-md px-4 pt-8">
        <Alert tone="info">Tu usuario no administra ningún negocio todavía.</Alert>
        <button className="mt-4 text-sm underline" onClick={() => void supabase.auth.signOut()}>
          Salir
        </button>
      </main>
    );

  const selectOrg = (id: string) => {
    setOrgId(id);
    try {
      localStorage.setItem(ORG_KEY, id);
    } catch {
      /* almacenamiento bloqueado */
    }
  };

  return (
    <PanelProvider
      key={org.id}
      orgId={org.id}
      token={session.access_token}
      role={org.role}
      fallback={(e) => (e ? <Alert tone="error">{e}</Alert> : <Spinner />)}
    >
      <Layout section={section} orgs={orgs} onSelectOrg={selectOrg} />
    </PanelProvider>
  );
}

function Layout({
  section,
  orgs,
  onSelectOrg,
}: {
  section: SectionKey;
  orgs: Org[];
  onSelectOrg: (id: string) => void;
}) {
  const { settings, orgId } = usePanel();
  const Current = SECTIONS.find((s) => s.key === section)!.Component;
  const [label, tone] = STATUS_LABEL[settings.status];

  useEffect(() => window.scrollTo(0, 0), [section]);

  return (
    <div className="mx-auto min-h-dvh w-full max-w-3xl px-4 pb-10 pt-3">
      <header className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-gray-500">Panel</p>
          <h1 className="truncate text-lg font-semibold" data-testid="panel-org-name">
            {settings.name}
          </h1>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Badge tone={tone}>{label}</Badge>
          <button className="text-sm underline" onClick={() => void supabase.auth.signOut()}>
            Salir
          </button>
        </div>
      </header>
      {orgs.length > 1 && (
        <select
          aria-label="Negocio"
          className={`${inputCls} mt-2`}
          value={orgId}
          onChange={(e) => onSelectOrg(e.target.value)}
        >
          {orgs.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      )}
      <nav
        aria-label="Secciones del panel"
        className="sticky top-0 z-10 -mx-4 mt-3 flex gap-1 overflow-x-auto border-b border-gray-200 bg-gray-50/95 px-4 py-2 backdrop-blur"
      >
        {SECTIONS.map((s) => (
          <Link
            key={s.key}
            to="/panel/$section"
            params={{ section: s.key }}
            aria-current={s.key === section ? 'page' : undefined}
            className={`shrink-0 rounded-full px-3 py-2 text-sm font-semibold ${
              s.key === section ? 'bg-gray-900 text-white' : 'text-gray-700 hover:bg-gray-200'
            }`}
          >
            {s.label}
          </Link>
        ))}
      </nav>
      <div className="mt-4 space-y-4">
        <Current />
      </div>
      <PoweredBy />
    </div>
  );
}
