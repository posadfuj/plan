import { useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { Alert, Page, PoweredBy, Spinner } from '../components/ui';

/** Lo que ve cualquier cámara que escanee el QR del cliente: sin nombre, saldo ni enlace privado. */
export function ScanPage() {
  const { token } = useParams({ strict: false }) as { token: string };
  const [msg, setMsg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api<{ message: string }>(`/v1/public/scan/${encodeURIComponent(token)}`)
      .then((r) => setMsg(r.message))
      .catch(() => setFailed(true));
  }, [token]);
  if (!msg && !failed) return <Spinner />;
  return (
    <Page>
      <div className="mt-16 text-center">
        <p className="text-5xl" aria-hidden>
          🎟️
        </p>
        <p className="mt-4 text-lg font-medium" data-testid="scan-message">
          {msg ?? 'Este código no es válido.'}
        </p>
        <p className="mt-2 text-sm text-gray-500">Este código solo sirve para identificarte en el local.</p>
      </div>
      {failed && (
        <div className="mt-6">
          <Alert tone="error">No reconocemos este código.</Alert>
        </div>
      )}
      <PoweredBy />
    </Page>
  );
}
