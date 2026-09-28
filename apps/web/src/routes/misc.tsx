import { Page, PoweredBy } from '../components/ui';

export function HomePage() {
  return (
    <Page>
      <div className="mt-24 text-center">
        <h1 className="text-3xl font-bold">Aiment Wallet</h1>
        <p className="mt-2 text-gray-600">Tarjetas de fidelización digitales para negocios.</p>
        <a href="/panel" className="mt-8 inline-block text-sm underline">
          Panel de negocios
        </a>
      </div>
      <PoweredBy />
    </Page>
  );
}

export function UnavailablePage() {
  return (
    <Page>
      <div className="mt-24 text-center">
        <h1 className="text-xl font-semibold">Este enlace no está disponible</h1>
        <p className="mt-2 text-gray-600">Pide ayuda en el local.</p>
      </div>
      <PoweredBy />
    </Page>
  );
}

/** Error inesperado en una pantalla: mensaje en español, opción de recargar y el detalle técnico. */
export function ErrorPage({ error }: { error: unknown }) {
  const detail = error instanceof Error ? error.message : String(error);
  return (
    <Page>
      <div className="mt-24 text-center" role="alert" data-testid="app-error">
        <h1 className="text-xl font-semibold">Algo salió mal</h1>
        <p className="mt-2 text-gray-600">Recarga la página. Si vuelve a pasar, avísanos.</p>
        <button
          className="mt-6 min-h-12 rounded-xl bg-gray-900 px-6 font-semibold text-white"
          onClick={() => window.location.reload()}
        >
          Recargar
        </button>
        <p className="mt-6 break-all text-xs text-gray-400">{detail}</p>
      </div>
      <PoweredBy />
    </Page>
  );
}
