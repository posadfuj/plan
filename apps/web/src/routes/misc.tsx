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
