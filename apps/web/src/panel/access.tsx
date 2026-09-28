/**
 * /panel/acceso?t=…&k=invite|magiclink — enlace del correo de invitación al dueño.
 * Canjea el código de un solo uso (una sola vez, aunque React monte la pantalla dos veces en
 * desarrollo), lo quita de la barra de direcciones y, si la cuenta es nueva, pide crear la contraseña.
 */
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, PoweredBy, Spinner } from '../components/ui';
import { inputCls, supabase } from './shared';

const redeemed = new Map<string, Promise<string | null>>();

function redeemOnce(tokenHash: string, type: 'invite' | 'magiclink') {
  if (!redeemed.has(tokenHash))
    redeemed.set(
      tokenHash,
      supabase.auth
        .verifyOtp({ token_hash: tokenHash, type })
        .then(({ error }) => (error ? error.message : null)),
    );
  return redeemed.get(tokenHash)!;
}

export function AccessPage() {
  const navigate = useNavigate();
  const [state, setState] = useState<'checking' | 'password' | 'error'>('checking');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const t = q.get('t') ?? '';
    const k = q.get('k') === 'magiclink' ? 'magiclink' : 'invite';
    // El código no queda en el historial del navegador.
    window.history.replaceState(null, '', '/panel/acceso');
    if (!/^[0-9a-f]{20,80}$/.test(t)) {
      setState('error');
      return;
    }
    void redeemOnce(t, k).then((err) => {
      if (err) setState('error');
      else if (k === 'invite') setState('password');
      else void navigate({ to: '/panel', replace: true });
    });
  }, [navigate]);

  async function savePassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const password = String(f.get('password'));
    if (password.length < 8) return setError('Usa al menos 8 caracteres.');
    if (password !== String(f.get('confirm'))) return setError('Las contraseñas no coinciden.');
    setBusy(true);
    const { error: err } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (err) return setError('No se pudo guardar la contraseña. Intenta con otra.');
    await navigate({ to: '/panel', replace: true });
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-4 pb-8 pt-4">
      <h1 className="mt-8 text-2xl font-semibold">Bienvenido a tu panel</h1>
      {state === 'checking' && <Spinner />}
      {state === 'error' && (
        <div className="mt-6 space-y-3">
          <Alert tone="error">
            Este enlace ya se usó o venció. Si ya creaste tu contraseña, entra con tu correo; si no, pide a
            Aiment un enlace nuevo.
          </Alert>
          <a href="/panel" className="block text-center font-semibold underline">
            Ir al panel
          </a>
        </div>
      )}
      {state === 'password' && (
        <form className="mt-6 space-y-3" onSubmit={savePassword}>
          <p className="text-sm text-gray-600">
            Crea tu contraseña para entrar las próximas veces con tu correo.
          </p>
          <input
            name="password"
            type="password"
            required
            minLength={8}
            placeholder="Contraseña nueva"
            autoComplete="new-password"
            className={inputCls}
          />
          <input
            name="confirm"
            type="password"
            required
            minLength={8}
            placeholder="Repite la contraseña"
            autoComplete="new-password"
            className={inputCls}
          />
          {error && <Alert tone="error">{error}</Alert>}
          <Button type="submit" disabled={busy}>
            {busy ? 'Guardando…' : 'Guardar y entrar'}
          </Button>
        </form>
      )}
      <PoweredBy />
    </main>
  );
}
