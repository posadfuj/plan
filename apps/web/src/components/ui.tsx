import { textOn } from '@aiment/core/branding';
import QRCode from 'qrcode';
import { useEffect, useState, type ReactNode } from 'react';

/** Texto blanco o negro según el color de marca (contraste AA garantizado, misma regla que la API). */
export const contrastText = textOn;

export function Page({ children }: { children: ReactNode }) {
  return <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-4 pb-8 pt-4">{children}</main>;
}

export function BrandHeader({
  name,
  color,
  subtitle,
  logoUrl,
}: {
  name: string;
  color: string;
  subtitle?: string | null;
  logoUrl?: string | null;
}) {
  const fg = contrastText(color);
  return (
    <header className="rounded-2xl px-5 py-5 shadow-sm" style={{ background: color, color: fg }}>
      <div className="flex items-center gap-3">
        {logoUrl ? (
          <img src={logoUrl} alt="" className="h-12 w-12 rounded-xl bg-white object-cover" />
        ) : (
          <div
            className="flex h-12 w-12 items-center justify-center rounded-xl text-xl font-bold"
            style={{ background: fg, color }}
            aria-hidden
          >
            {name.trim().charAt(0).toUpperCase()}
          </div>
        )}
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold">{name}</h1>
          {subtitle && <p className="truncate text-sm opacity-80">{subtitle}</p>}
        </div>
      </div>
    </header>
  );
}

export function PoweredBy() {
  return (
    <footer className="mt-auto pt-8 text-center text-xs text-gray-400" data-testid="powered-by">
      Powered by <span className="font-semibold text-gray-500">Aiment Wallet</span>
    </footer>
  );
}

export function Button({
  children,
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`min-h-12 w-full rounded-xl bg-gray-900 px-4 text-base font-semibold text-white active:scale-[.99] disabled:opacity-50 ${className}`}
    >
      {children}
    </button>
  );
}

export function Alert({ tone = 'info', children }: { tone?: 'info' | 'error' | 'ok'; children: ReactNode }) {
  const cls = {
    info: 'bg-blue-50 text-blue-900',
    error: 'bg-red-50 text-red-800',
    ok: 'bg-emerald-50 text-emerald-900',
  }[tone];
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-xl px-4 py-3 text-sm ${cls}`}>
      {children}
    </div>
  );
}

/** QR generado en el navegador (sin servicios externos: la URL nunca sale del dispositivo). */
export function QrImage({ value, label, size = 220 }: { value: string; label: string; size?: number }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    void QRCode.toString(value, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).then(setSvg);
  }, [value]);
  return (
    <div
      role="img"
      aria-label={label}
      data-testid="qr"
      className="mx-auto [&>svg]:h-full [&>svg]:w-full"
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export function Spinner() {
  return <p className="py-16 text-center text-gray-500">Cargando…</p>;
}
