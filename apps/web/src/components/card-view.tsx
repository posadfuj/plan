/**
 * Tarjeta web del cliente. La usan la página /m/{token} y la vista previa del panel del dueño
 * (así lo que el dueño ve al configurar es exactamente lo que verá su cliente).
 */
import { useState } from 'react';
import { api, type ApiError, type Card } from '../api';
import { Alert, BrandHeader, Page, PoweredBy, QrImage } from './ui';

const LABELS: Record<string, string> = {
  earn: 'Visita / compra',
  bonus: 'Bono de bienvenida',
  redeem: 'Canje',
  adjust: 'Ajuste',
  reversal: 'Anulación',
  expire: 'Vencimiento',
};

function Stamps({ current, target, color }: { current: number; target: number; color: string }) {
  return (
    <div className="grid grid-cols-5 gap-2" aria-label={`${current} de ${target}`}>
      {Array.from({ length: target }, (_, i) => (
        <div
          key={i}
          className="aspect-square rounded-full border-2"
          style={i < current ? { background: color, borderColor: color } : { borderColor: '#d1d5db' }}
        />
      ))}
    </div>
  );
}

/** Botón de Wallet desactivado, con "Próximamente" visible (no solo al pasar el mouse). */
function WalletSoon({ label, className }: { label: string; className: string }) {
  return (
    <button
      disabled
      aria-disabled
      className={`flex min-h-14 flex-col items-center justify-center rounded-xl px-3 text-white opacity-60 ${className}`}
    >
      <span className="text-sm font-semibold">Agregar a {label}</span>
      <span className="mt-0.5 rounded-full bg-white/25 px-2 text-[11px] font-semibold uppercase tracking-wide">
        Próximamente
      </span>
    </button>
  );
}

/**
 * "Agregar a Google Wallet": pide el enlace al servidor y abre la página de Google (o la vista
 * simulada en local). La tarjeta web sigue funcionando igual si esto falla.
 */
function GoogleWalletButton({ token }: { token: string | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const { url } = await api<{ url: string }>(
        `/v1/public/cards/${encodeURIComponent(token)}/wallet/google`,
        { method: 'POST' },
      );
      window.location.assign(url);
    } catch (e) {
      setError((e as ApiError).message);
      setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        onClick={() => void add()}
        disabled={busy || !token}
        aria-busy={busy}
        className="flex min-h-14 flex-col items-center justify-center rounded-xl bg-black px-3 text-white active:scale-[.99] disabled:opacity-60"
        data-testid="google-wallet-button"
      >
        <span className="text-sm font-semibold">{busy ? 'Abriendo…' : 'Agregar a Google Wallet'}</span>
      </button>
      {error && (
        <div className="col-span-full">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
    </>
  );
}

/** Qué Wallet tiene el celular: Google solo en Android, Apple solo en iPhone/iPad. */
export function walletPlatform(nav: Pick<Navigator, 'userAgent' | 'maxTouchPoints'> = navigator) {
  if (/Android/i.test(nav.userAgent)) return 'android' as const;
  // iPadOS se presenta como Mac: se reconoce por la pantalla táctil.
  if (/iPhone|iPad|iPod/i.test(nav.userAgent) || (/Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1))
    return 'ios' as const;
  return 'other' as const;
}

/**
 * Botones de Wallet según el celular. 'all' = vista previa del panel: el dueño ve los dos.
 * La tarjeta web funciona siempre, con o sin Wallet.
 */
function WalletButtons({
  platform,
  google,
  token,
}: {
  platform: 'android' | 'ios' | 'other' | 'all';
  google: boolean;
  token: string | null;
}) {
  const showApple = platform === 'ios' || platform === 'all';
  const showGoogle = platform === 'android' || platform === 'all';
  const note =
    platform === 'other'
      ? 'Abre esta tarjeta en tu celular para guardarla en tu Wallet. Esta tarjeta web funciona siempre.'
      : platform === 'android' && google
        ? 'Guárdala en Google Wallet: se actualiza sola. Esta tarjeta web funciona siempre.'
        : 'Muy pronto podrás guardarla en tu Wallet. Esta tarjeta web funciona siempre.';
  return (
    <section
      className={`mt-4 grid gap-3 ${showApple && showGoogle ? 'grid-cols-2' : 'grid-cols-1'}`}
      data-testid="wallet-buttons"
      data-platform={platform}
    >
      {showApple && <WalletSoon label="Apple Wallet" className="bg-black" />}
      {showGoogle &&
        (google ? (
          <GoogleWalletButton token={token} />
        ) : (
          <WalletSoon label="Google Wallet" className="bg-gray-800" />
        ))}
      <p className="col-span-full -mt-1 text-center text-xs text-gray-500">{note}</p>
    </section>
  );
}

function Contact({ contact }: { contact: Card['organization']['branding']['contact'] }) {
  const items = [
    contact.phone && { label: contact.phone, href: `tel:${contact.phone.replace(/[^+0-9]/g, '')}` },
    contact.instagram && {
      label: `@${contact.instagram}`,
      href: `https://instagram.com/${contact.instagram}`,
    },
    contact.website && { label: contact.website.replace(/^https?:\/\//, ''), href: contact.website },
    contact.email && { label: contact.email, href: `mailto:${contact.email}` },
  ].filter(Boolean) as { label: string; href: string }[];
  if (!items.length) return null;
  return (
    <ul className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-1 text-sm" data-testid="brand-contact">
      {items.map((i) => (
        <li key={i.href}>
          <a className="underline" href={i.href} target="_blank" rel="noreferrer noopener">
            {i.label}
          </a>
        </li>
      ))}
    </ul>
  );
}

export function CardView({
  card,
  scanUrl,
  preview = false,
  token = null,
}: {
  card: Card;
  scanUrl: string;
  preview?: boolean;
  /** Token de la tarjeta (para pedir el pase de Wallet). La vista previa del panel no lo tiene. */
  token?: string | null;
}) {
  const google = card.wallet.google.available;
  const { branding } = card.organization;
  const isStamps = card.program.mode === 'stamps';
  const Wrapper = preview ? PreviewFrame : Page;

  return (
    <Wrapper>
      <BrandHeader
        name={card.organization.name}
        color={branding.primaryColor}
        logoUrl={branding.logoUrl}
        subtitle={card.program.name}
      />
      {branding.tagline && (
        <p className="mt-2 text-center text-sm text-gray-600" data-testid="brand-tagline">
          {branding.tagline}
        </p>
      )}

      {card.message && card.status === 'active' && (
        <div
          className="mt-4 rounded-2xl border-2 bg-white p-4 text-center text-base font-semibold shadow-sm"
          style={{ borderColor: branding.primaryColor }}
          role="status"
          data-testid="card-message"
        >
          {card.message.text}
        </div>
      )}

      <section className="mt-4 rounded-2xl bg-white p-5 shadow-sm">
        <p className="text-sm text-gray-500">Tarjeta de</p>
        <p className="text-xl font-semibold" data-testid="customer-name">
          {card.customer.name}
        </p>
        <div className="mt-4">
          <p className="text-4xl font-bold" data-testid="balance">
            {card.balance} <span className="text-lg font-medium text-gray-500">{card.program.unitLabel}</span>
          </p>
          {card.progress && (
            <div className="mt-3">
              {isStamps ? (
                <Stamps
                  current={card.progress.current}
                  target={card.progress.target}
                  color={branding.primaryColor}
                />
              ) : (
                <div className="h-3 w-full overflow-hidden rounded-full bg-gray-200">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.min(100, (card.progress.current / card.progress.target) * 100)}%`,
                      background: branding.primaryColor,
                    }}
                  />
                </div>
              )}
              <p className="mt-2 text-sm text-gray-600" data-testid="progress">
                {card.progress.current} de {card.progress.target} {card.program.unitLabel}
              </p>
            </div>
          )}
          {card.nextReward && (
            <p className="mt-2 text-sm" data-testid="next-reward">
              Te {card.nextReward.remaining === 1 ? 'falta' : 'faltan'}{' '}
              <strong>{card.nextReward.remaining}</strong> para: {card.nextReward.name}
            </p>
          )}
          {card.redeemable.length > 0 && (
            <div className="mt-3">
              <Alert tone="ok">Puedes canjear en caja: {card.redeemable.join(', ')}</Alert>
            </div>
          )}
        </div>
      </section>

      {card.status === 'blocked' ? (
        <div className="mt-4" data-testid="card-blocked">
          <Alert tone="error">
            Tu tarjeta está pausada por {card.organization.name}. Consulta en el local: tus{' '}
            {card.program.unitLabel} siguen guardados.
          </Alert>
        </div>
      ) : (
        <section className="mt-4 rounded-2xl bg-white p-5 text-center shadow-sm">
          <p className="mb-3 text-sm font-medium">Muestra este código en caja</p>
          <QrImage value={scanUrl} label="Código QR para identificarte en caja" size={preview ? 160 : 220} />
          <p className="mt-3 font-mono text-lg tracking-widest" data-testid="short-code">
            {card.shortCode}
          </p>
          <p className="text-xs text-gray-500">Si la cámara falla, dicta este código.</p>
        </section>
      )}

      <WalletButtons
        platform={preview ? 'all' : walletPlatform()}
        google={google}
        token={preview ? null : token}
      />

      {card.history.length > 0 && (
        <section className="mt-4 rounded-2xl bg-white p-5 shadow-sm">
          <h2 className="mb-2 text-sm font-semibold">Últimos movimientos</h2>
          <ul className="divide-y divide-gray-100 text-sm">
            {card.history.map((h, i) => (
              <li key={i} className="flex justify-between py-2">
                <span>
                  {LABELS[h.kind] ?? h.kind}{' '}
                  <span className="text-gray-400">· {new Date(h.at).toLocaleDateString('es-PE')}</span>
                </span>
                <span className={h.delta > 0 ? 'text-emerald-700' : 'text-gray-700'}>
                  {h.delta > 0 ? '+' : ''}
                  {h.delta}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {branding.conditions && (
        <details className="mt-4 rounded-2xl bg-white p-5 text-sm shadow-sm" data-testid="brand-conditions">
          <summary className="cursor-pointer font-semibold">Condiciones del programa</summary>
          <p className="mt-2 whitespace-pre-line text-gray-700">{branding.conditions}</p>
        </details>
      )}
      <Contact contact={branding.contact} />
      <p className="mt-4 text-center text-xs text-gray-500">
        Guarda este enlace: es tu tarjeta. No lo compartas.
      </p>
      <PoweredBy />
    </Wrapper>
  );
}

function PreviewFrame({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex flex-col rounded-[2rem] border-8 border-gray-900 bg-gray-50 px-3 pb-4 pt-3"
      data-testid="card-preview"
    >
      {children}
    </div>
  );
}
