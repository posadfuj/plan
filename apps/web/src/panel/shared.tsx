/**
 * Piezas compartidas del panel del dueño y del panel maestro: sesión de Supabase Auth, contexto del
 * negocio abierto, llamadas a la API y controles de formulario.
 */
import { createClient, type Session } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, type Branding } from '../api';

export const supabase = createClient(
  window.location.origin,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'missing-key',
  // detectSessionInUrl: false → el enlace de invitación lo canjea /panel/acceso a mano (una sola vez).
  { auth: { persistSession: true, storageKey: 'aiment.panel.auth', detectSessionInUrl: false } },
);

/** undefined = cargando · null = sin sesión. */
export function useSession(): Session | null | undefined {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);
  return session;
}

export type Role = 'owner' | 'admin' | 'staff';

export interface Settings {
  id: string;
  name: string;
  slug: string;
  category: string | null;
  status: 'draft' | 'pending_review' | 'live' | 'suspended' | 'cancelled';
  branding: Branding & { hasLogo: boolean };
  colorCheck: { level: 'ok' | 'low'; suggestion: string | null; textRatio: number; onWhiteRatio: number };
  plan: { code: string; name: string };
  limits: { branches: number | null; staff: number | null };
  usage: { branches: number; staff: number };
}

export interface PanelCtx {
  orgId: string;
  token: string;
  role: Role;
  settings: Settings;
  reload: () => Promise<void>;
  /** Llamada a /v1/orgs/{orgId}{path} con la sesión del panel. */
  call: <T>(path: string, init?: Parameters<typeof api>[1]) => Promise<T>;
}

const Ctx = createContext<PanelCtx | null>(null);
export const usePanel = () => useContext(Ctx)!;

export function PanelProvider({
  orgId,
  token,
  role,
  children,
  fallback,
}: {
  orgId: string;
  token: string;
  role: Role;
  children: ReactNode;
  fallback: (error: string | null) => ReactNode;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const call = useCallback(
    <T,>(path: string, init: Parameters<typeof api>[1] = {}) =>
      api<T>(`/v1/orgs/${orgId}${path}`, { ...init, token }),
    [orgId, token],
  );
  const reload = useCallback(async () => {
    try {
      setSettings(await call<Settings>('/settings'));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'No se pudo cargar el negocio');
    }
  }, [call]);
  useEffect(() => {
    setSettings(null);
    void reload();
  }, [reload]);
  if (!settings) return <>{fallback(error)}</>;
  return <Ctx.Provider value={{ orgId, token, role, settings, reload, call }}>{children}</Ctx.Provider>;
}

/** Mensaje de resultado de una acción (ok / error) y un envoltorio que lo maneja. */
export function useAction() {
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn: () => Promise<unknown>, ok?: string): Promise<boolean> => {
    setMsg(null);
    setBusy(true);
    try {
      await fn();
      if (ok) setMsg({ tone: 'ok', text: ok });
      return true;
    } catch (e) {
      setMsg({ tone: 'error', text: errorText(e) });
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { msg, setMsg, busy, run };
}

/** Mensaje legible, incluidos los errores de validación (400) con su campo. */
export function errorText(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Ocurrió un error. Intenta de nuevo.';
  if (e.code === 'invalid_request') return 'Revisa los datos: hay un campo con formato inválido.';
  return e.message;
}

// ---------------------------------------------------------------------------
// Controles
// ---------------------------------------------------------------------------
export const inputCls =
  'h-12 w-full rounded-xl border border-gray-300 bg-white px-3 text-base disabled:bg-gray-100 disabled:text-gray-500';

export function Card({
  title,
  children,
  testId,
  aside,
}: {
  title?: string;
  children: ReactNode;
  testId?: string;
  aside?: ReactNode;
}) {
  return (
    <section className="rounded-2xl bg-white p-4 shadow-sm" data-testid={testId}>
      {(title || aside) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="text-base font-semibold">{title}</h2>}
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-1 block text-xs text-gray-500">{hint}</span>}
    </label>
  );
}

export function SmallButton({
  tone = 'default',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'default' | 'primary' | 'danger' }) {
  const cls = {
    default: 'ring-1 ring-gray-300 bg-white',
    primary: 'bg-gray-900 text-white',
    danger: 'text-red-700 ring-1 ring-red-200 bg-white',
  }[tone];
  return (
    <button
      type="button"
      {...props}
      className={`min-h-11 rounded-xl px-3 text-sm font-semibold disabled:opacity-50 ${cls} ${className}`}
    />
  );
}

export function Badge({ tone, children }: { tone: 'green' | 'amber' | 'red' | 'gray'; children: ReactNode }) {
  const cls = {
    green: 'bg-emerald-100 text-emerald-800',
    amber: 'bg-amber-100 text-amber-900',
    red: 'bg-red-100 text-red-800',
    gray: 'bg-gray-100 text-gray-700',
  }[tone];
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>{children}</span>
  );
}

export const STATUS_LABEL: Record<Settings['status'], [string, 'green' | 'amber' | 'red' | 'gray']> = {
  draft: ['En preparación', 'amber'],
  pending_review: ['En revisión', 'amber'],
  live: ['Publicado', 'green'],
  suspended: ['Suspendido', 'red'],
  cancelled: ['Cancelado', 'gray'],
};

export const fmtDate = (d: string | null) => (d ? new Date(d).toLocaleDateString('es-PE') : '—');
export const fmtDateTime = (d: string | null) =>
  d ? new Date(d).toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' }) : '—';

/** Uso del plan "2 de 3" o "2 (sin tope)". */
export function usageText(used: number, max: number | null, one: string, many: string) {
  return max === null ? `${used} ${used === 1 ? one : many}` : `${used} de ${max} ${max === 1 ? one : many}`;
}
