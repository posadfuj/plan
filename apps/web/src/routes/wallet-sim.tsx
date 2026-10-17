/**
 * Google Wallet simulado (solo local, sin cuenta de Google): muestra el pase tal como lo recibe
 * Google. El JWT llega en el fragmento de la URL (#...), así que nunca se envía a ningún servidor.
 * Con la cuenta real configurada, el botón de la tarjeta abre pay.google.com y esta página no se usa.
 */
import { useEffect, useState } from 'react';
import { Alert, contrastText, Page, PoweredBy, QrImage } from '../components/ui';

interface SimClass {
  issuerName: string;
  programName: string;
  programLogo?: { sourceUri?: { uri?: string } };
  hexBackgroundColor?: string;
}
interface SimObject {
  accountId?: string;
  accountName?: string;
  loyaltyPoints?: { label: string; balance: { int: number } };
  secondaryLoyaltyPoints?: { label: string; balance: { int: number } };
  barcode?: { type: string; value: string; alternateText?: string };
  textModulesData?: { id: string; header: string; body: string }[];
}

function decode(hash: string): { cls: SimClass; obj: SimObject } | null {
  try {
    const part = hash.replace(/^#/, '').split('.')[1] ?? '';
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(json, (ch) => ch.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder().decode(bytes)) as {
      payload?: { loyaltyClasses?: SimClass[]; loyaltyObjects?: SimObject[] };
    };
    const cls = claims.payload?.loyaltyClasses?.[0];
    const obj = claims.payload?.loyaltyObjects?.[0];
    return cls && obj ? { cls, obj } : null;
  } catch {
    return null;
  }
}

export function GoogleWalletSimPage() {
  const [pass, setPass] = useState(() => decode(window.location.hash));
  useEffect(() => {
    const onHash = () => setPass(decode(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return (
    <Page>
      <div data-testid="sim-banner">
        <Alert>
          <strong>Google Wallet simulado.</strong> Así llega el pase a Google. No se guardó en ningún celular:
          cuando se conecte la cuenta de Google del negocio, este botón abrirá Google Wallet.
        </Alert>
      </div>
      {pass ? <SimPass {...pass} /> : <Alert tone="error">Este enlace de pase no es válido.</Alert>}
      <button
        type="button"
        className="mt-4 min-h-12 rounded-xl border border-gray-300 bg-white px-4 font-semibold"
        onClick={() => window.history.back()}
      >
        Volver a mi tarjeta
      </button>
      <PoweredBy />
    </Page>
  );
}

function SimPass({ cls, obj }: { cls: SimClass; obj: SimObject }) {
  const bg = cls.hexBackgroundColor ?? '#1F2937';
  const fg = contrastText(bg);
  const logo = cls.programLogo?.sourceUri?.uri;
  return (
    <article
      className="mt-4 overflow-hidden rounded-3xl shadow-lg"
      style={{ background: bg, color: fg }}
      data-testid="sim-pass"
    >
      <header className="flex items-center gap-3 px-5 pt-5">
        {logo && <img src={logo} alt="" className="h-10 w-10 rounded-full bg-white object-cover" />}
        <span className="truncate font-medium" data-testid="sim-issuer">
          {cls.issuerName}
        </span>
      </header>
      <p className="px-5 pt-3 text-2xl font-semibold" data-testid="sim-program">
        {cls.programName}
      </p>
      <dl className="grid grid-cols-2 gap-3 px-5 pt-4 text-sm">
        {obj.loyaltyPoints && (
          <div>
            <dt className="opacity-80">{obj.loyaltyPoints.label}</dt>
            <dd className="text-2xl font-semibold" data-testid="sim-balance">
              {obj.loyaltyPoints.balance.int}
            </dd>
          </div>
        )}
        {obj.secondaryLoyaltyPoints && (
          <div>
            <dt className="opacity-80">{obj.secondaryLoyaltyPoints.label}</dt>
            <dd className="text-2xl font-semibold" data-testid="sim-rewards">
              {obj.secondaryLoyaltyPoints.balance.int}
            </dd>
          </div>
        )}
        <div className="col-span-2">
          <dt className="opacity-80">Nombre</dt>
          <dd className="font-medium" data-testid="sim-account">
            {obj.accountName}
          </dd>
        </div>
      </dl>
      {obj.barcode?.type === 'QR_CODE' ? (
        <div className="m-5 rounded-2xl bg-white p-4 text-center text-gray-900">
          <QrImage value={obj.barcode.value} label="QR del pase para la caja" size={180} />
          <p className="mt-2 font-mono tracking-widest" data-testid="sim-code">
            {obj.barcode.alternateText}
          </p>
        </div>
      ) : (
        <p
          className="m-5 rounded-2xl bg-white p-4 text-center font-semibold text-gray-900"
          data-testid="sim-code"
        >
          {obj.barcode?.value}
        </p>
      )}
      <ul className="bg-white px-5 py-3 text-sm text-gray-800" data-testid="sim-details">
        {obj.textModulesData?.map((m) => (
          <li key={m.id} className="py-1">
            <span className="font-semibold">{m.header}:</span> {m.body}
          </li>
        ))}
      </ul>
    </article>
  );
}
