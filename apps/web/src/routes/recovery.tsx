import { useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { Alert, Button, Page, PoweredBy, Spinner } from '../components/ui';

export function RecoverPage() {
  const { code } = useParams({ strict: false }) as { code: string };
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSending(true);
    try {
      const contact = String(new FormData(e.currentTarget).get('contact') ?? '');
      const r = await api<{ message: string }>('/v1/public/recovery', {
        method: 'POST',
        json: { code, contact },
      });
      setMessage(r.message);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Ocurrió un error.');
    } finally {
      setSending(false);
    }
  }

  return (
    <Page>
      <h1 className="mt-4 text-2xl font-semibold">Recuperar mi tarjeta</h1>
      <p className="mt-2 text-sm text-gray-600">
        Escribe el correo o el celular con el que te registraste. Te enviaremos un enlace al correo que
        registraste.
      </p>
      {message ? (
        <div className="mt-6">
          <Alert tone="ok">{message}</Alert>
        </div>
      ) : (
        <form className="mt-6 space-y-4" onSubmit={onSubmit}>
          <input
            name="contact"
            required
            placeholder="correo@ejemplo.com o 987 654 321"
            className="h-12 w-full rounded-xl border border-gray-300 bg-white px-3 text-base"
          />
          {error && <Alert tone="error">{error}</Alert>}
          <Button type="submit" disabled={sending}>
            {sending ? 'Enviando…' : 'Enviarme el enlace'}
          </Button>
        </form>
      )}
      <p className="mt-6 text-sm text-gray-600">
        ¿No registraste correo? Pide tu tarjeta en caja: te mostrarán un código para abrirla.
      </p>
      <PoweredBy />
    </Page>
  );
}

/** Abre un enlace de recuperación (un solo uso) y lleva a la tarjeta existente. */
export function RedeemPage() {
  const { token } = useParams({ strict: false }) as { token: string };
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return; // evita doble canje en modo estricto de React
    started.current = true;
    api<{ webCardToken: string }>('/v1/public/recovery/redeem', { method: 'POST', json: { token } })
      .then((r) => navigate({ to: '/m/$token', params: { token: r.webCardToken }, replace: true }))
      .catch((e: ApiError) => setError(e.message));
  }, [token, navigate]);
  if (!error) return <Spinner />;
  return (
    <Page>
      <div className="mt-8">
        <Alert tone="error">{error}</Alert>
      </div>
      <PoweredBy />
    </Page>
  );
}
