import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type JoinInfo, type RegisterResult } from '../api';
import { Alert, BrandHeader, Button, Page, PoweredBy, Spinner } from '../components/ui';
import { rememberCard, savedCard } from '../storage';

function benefit(info: JoinInfo): string {
  const p = info.program;
  const goal = p.rewards.find((r) => r.kind === 'goal');
  if (p.mode === 'stamps' && p.goal && goal) return `Junta ${p.goal} ${p.unitLabel} y gana: ${goal.name}.`;
  const cheapest = p.rewards.filter((r) => r.cost).sort((a, b) => a.cost! - b.cost!)[0];
  return cheapest
    ? `Acumula ${p.unitLabel} con cada compra y canjéalos por premios desde ${cheapest.cost} ${p.unitLabel}.`
    : `Acumula ${p.unitLabel} con cada compra.`;
}

/** Formatea mientras se escribe: solo números, con las barras de dd/mm/aaaa. */
export function formatBirthday(raw: string): string {
  const d = raw.replace(/\D/g, '').slice(0, 8);
  if (d.length <= 2) return d;
  if (d.length <= 4) return `${d.slice(0, 2)}/${d.slice(2)}`;
  return `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4)}`;
}

export function JoinPage() {
  const { code } = useParams({ strict: false }) as { code: string };
  const search = useSearch({ strict: false }) as { c?: string; v?: number | string };
  const navigate = useNavigate();
  const [info, setInfo] = useState<JoinInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [birthday, setBirthday] = useState('');

  useEffect(() => {
    api<JoinInfo>(`/v1/public/join/${encodeURIComponent(code)}`)
      .then(setInfo)
      .catch((e: ApiError) => setError(e.status === 404 ? 'Este enlace no está disponible.' : e.message));
  }, [code]);

  if (error && !info)
    return (
      <Page>
        <Alert tone="error">{error}</Alert>
        <PoweredBy />
      </Page>
    );
  if (!info) return <Spinner />;
  const existing = savedCard(info.organization.id);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const accepted = f.get('accept') === 'on';
    setError(null);
    setNotice(null);
    setSending(true);
    try {
      const r = await api<RegisterResult>('/v1/public/register', {
        method: 'POST',
        json: {
          code,
          fullName: String(f.get('fullName') ?? ''),
          phone: String(f.get('phone') ?? ''),
          email: String(f.get('email') ?? ''),
          birthDate: birthday,
          acceptTerms: accepted,
          acceptPrivacy: accepted,
          acceptMarketing: f.get('marketing') === 'on',
          channel: search.c === 'qr' || search.c === 'nfc' ? search.c : 'direct',
          visitId: search.v ? Number(search.v) : undefined,
        },
      });
      if (r.status === 'created') {
        rememberCard(info!.organization.id, r.webCardToken);
        await navigate({ to: '/m/$token', params: { token: r.webCardToken }, replace: true });
      } else setNotice(r.message);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Ocurrió un error. Intenta de nuevo.');
    } finally {
      setSending(false);
    }
  }

  const { branding } = info.organization;
  return (
    <Page>
      <BrandHeader
        name={info.organization.name}
        color={branding.primaryColor}
        logoUrl={branding.logoUrl}
        subtitle={info.program.name}
      />
      <p className="mt-4 text-lg font-medium">{benefit(info)}</p>
      <p className="mt-1 text-sm text-gray-600">Regístrate en 30 segundos. Tu tarjeta queda en tu celular.</p>

      {existing && (
        <div className="mt-4">
          <Alert tone="ok">
            Ya tienes una tarjeta en este negocio.{' '}
            <Link to="/m/$token" params={{ token: existing }} className="font-semibold underline">
              Abrir mi tarjeta
            </Link>
          </Alert>
        </div>
      )}

      <form className="mt-5 space-y-4" onSubmit={onSubmit} noValidate>
        <label className="block">
          <span className="text-sm font-medium">Nombre y apellido</span>
          <input
            name="fullName"
            required
            autoComplete="name"
            maxLength={80}
            className="mt-1 h-12 w-full rounded-xl border border-gray-300 bg-white px-3 text-base"
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium">Celular</span>
          <input
            name="phone"
            required
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="987 654 321"
            className="mt-1 h-12 w-full rounded-xl border border-gray-300 bg-white px-3 text-base"
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium">Correo (opcional)</span>
          <input
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            className="mt-1 h-12 w-full rounded-xl border border-gray-300 bg-white px-3 text-base"
          />
          <span className="mt-1 block text-xs text-gray-500">
            Para recuperar tu tarjeta si cambias de celular.
          </span>
        </label>
        <label className="block">
          <span className="text-sm font-medium">Cumpleaños (opcional)</span>
          <input
            name="birthDate"
            type="text"
            inputMode="numeric"
            autoComplete="bday"
            placeholder="dd/mm/aaaa"
            maxLength={10}
            value={birthday}
            onChange={(e) => setBirthday(formatBirthday(e.target.value))}
            className="mt-1 h-12 w-full rounded-xl border border-gray-300 bg-white px-3 text-base"
          />
          <span className="mt-1 block text-xs text-gray-500">
            Para beneficios de cumpleaños, cuando el negocio los active.
          </span>
        </label>

        <label className="flex items-start gap-3 text-sm">
          <input name="accept" type="checkbox" required className="mt-0.5 h-5 w-5 shrink-0" />
          <span>
            Acepto los{' '}
            <button type="button" className="underline" onClick={() => setShowTerms((v) => !v)}>
              términos y la política de privacidad
            </button>
          </span>
        </label>
        {showTerms && (
          <div className="max-h-48 overflow-auto rounded-xl bg-white p-3 text-xs text-gray-600 ring-1 ring-gray-200">
            <p className="font-semibold">Términos (v{info.consents.terms?.version})</p>
            <p className="mb-2 whitespace-pre-line">{info.consents.terms?.body}</p>
            <p className="font-semibold">Privacidad (v{info.consents.privacy?.version})</p>
            <p className="whitespace-pre-line">{info.consents.privacy?.body}</p>
          </div>
        )}
        {info.consents.marketing && (
          <label className="flex items-start gap-3 text-sm">
            <input name="marketing" type="checkbox" className="mt-0.5 h-5 w-5 shrink-0" />
            <span>Quiero recibir promociones de {info.organization.name} (opcional).</span>
          </label>
        )}

        {error && <Alert tone="error">{error}</Alert>}
        {notice && (
          <Alert tone="info">
            {notice}{' '}
            <Link to="/recuperar/$code" params={{ code }} className="font-semibold underline">
              Recuperar mi tarjeta
            </Link>
          </Alert>
        )}
        <Button type="submit" disabled={sending}>
          {sending ? 'Creando tu tarjeta…' : 'Crear mi tarjeta'}
        </Button>
      </form>
      <p className="mt-4 text-center text-sm">
        ¿Ya te registraste?{' '}
        <Link to="/recuperar/$code" params={{ code }} className="font-semibold underline">
          Recuperar mi tarjeta
        </Link>
      </p>
      <PoweredBy />
    </Page>
  );
}
