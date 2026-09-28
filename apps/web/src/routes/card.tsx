import { useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { api, type ApiError, type Card } from '../api';
import { Alert, BrandHeader, Page, PoweredBy, QrImage, Spinner } from '../components/ui';
import { forgetToken, rememberCard } from '../storage';

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

export function CardPage() {
  const { token } = useParams({ strict: false }) as { token: string };
  const [card, setCard] = useState<Card | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<Card>(`/v1/public/cards/${encodeURIComponent(token)}`)
        .then((c) => {
          if (!alive) return;
          setCard(c);
          rememberCard(c.organization.id, token);
        })
        .catch((e: ApiError) => {
          if (!alive) return;
          if (e.status === 404) {
            // La URL pudo quedar vieja: al recuperar la tarjeta en otro celular se genera una nueva.
            forgetToken(token);
            setError(
              'Este enlace de tarjeta ya no funciona. Si recuperaste tu tarjeta en otro celular, usa el enlace nuevo; si no, pídela en caja o con tu correo desde el QR del local.',
            );
          } else setError(e.message);
        });
    void load();
    const onFocus = () => void load(); // al volver a la pestaña, saldo actualizado
    window.addEventListener('focus', onFocus);
    return () => {
      alive = false;
      window.removeEventListener('focus', onFocus);
    };
  }, [token]);

  if (error)
    return (
      <Page>
        <Alert tone="error">{error}</Alert>
        <PoweredBy />
      </Page>
    );
  if (!card) return <Spinner />;

  const { branding } = card.organization;
  const scanUrl = `${window.location.origin}${card.scanPath}`;
  const isStamps = card.program.mode === 'stamps';

  return (
    <Page>
      <BrandHeader
        name={card.organization.name}
        color={branding.primaryColor}
        logoUrl={branding.logoUrl}
        subtitle={card.program.name}
      />

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

      <section className="mt-4 rounded-2xl bg-white p-5 text-center shadow-sm">
        <p className="mb-3 text-sm font-medium">Muestra este código en caja</p>
        <QrImage value={scanUrl} label="Código QR para identificarte en caja" />
        <p className="mt-3 font-mono text-lg tracking-widest" data-testid="short-code">
          {card.shortCode}
        </p>
        <p className="text-xs text-gray-500">Si la cámara falla, dicta este código.</p>
      </section>

      <section className="mt-4 grid grid-cols-2 gap-3" data-testid="wallet-buttons">
        <WalletSoon label="Apple Wallet" className="bg-black" />
        <WalletSoon label="Google Wallet" className="bg-gray-800" />
        <p className="col-span-2 -mt-1 text-center text-xs text-gray-500">
          Muy pronto podrás guardarla en tu Wallet. Esta tarjeta web funciona siempre.
        </p>
      </section>

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
      <p className="mt-4 text-center text-xs text-gray-500">
        Guarda este enlace: es tu tarjeta. No lo compartas.
      </p>
      <PoweredBy />
    </Page>
  );
}
