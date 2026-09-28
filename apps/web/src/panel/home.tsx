/** Inicio: estado del negocio, lista de configuración pendiente, uso del plan y números básicos. */
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Alert } from '../components/ui';
import { Card, usageText, usePanel } from './shared';

interface Overview {
  stats: { customers: number; movements30d: number; rewardsAvailable: number };
}
interface Team {
  team: { role: string; status: string; hasPin: boolean; isMe: boolean }[];
}
interface Branches {
  branches: { status: string; address: string | null }[];
}
interface Devices {
  devices: { revokedAt: string | null }[];
}

export function HomeSection() {
  const { settings, call, role } = usePanel();
  const [data, setData] = useState<{ o: Overview; t: Team; b: Branches; d: Devices } | null>(null);

  useEffect(() => {
    void Promise.all([
      call<Overview>(''),
      call<Team>('/team'),
      call<Branches>('/branches'),
      call<Devices>('/devices').catch(() => ({ devices: [] })),
    ]).then(([o, t, b, d]) => setData({ o, t, b, d }));
  }, [call]);

  const b = settings.branding;
  const me = data?.t.team.find((p) => p.isMe);
  const activeBranches = data?.b.branches.filter((x) => x.status === 'active') ?? [];
  const steps: { done: boolean; text: string; to: string }[] = data
    ? [
        { done: b.hasLogo, text: 'Sube tu logo y elige tu color', to: 'marca' },
        { done: !!b.conditions, text: 'Escribe las condiciones del programa', to: 'marca' },
        {
          done: !!(b.contact.phone || b.contact.instagram || b.contact.website || b.contact.email),
          text: 'Agrega un contacto (teléfono, Instagram o web)',
          to: 'marca',
        },
        {
          done: activeBranches.every((x) => !!x.address),
          text: 'Completa la dirección de tu sucursal',
          to: 'sucursales',
        },
        { done: !!me?.hasPin, text: 'Define tu PIN (autoriza excepciones en caja)', to: 'equipo' },
        {
          done: data.t.team.some((p) => p.role === 'staff' && p.status === 'active'),
          text: 'Agrega a tu equipo de caja con su PIN',
          to: 'equipo',
        },
        {
          done: data.d.devices.some((x) => !x.revokedAt),
          text:
            settings.status === 'live'
              ? 'Autoriza el celular o tablet de la caja'
              : 'Autoriza la caja (se habilita al publicar)',
          to: 'cajas',
        },
      ]
    : [];
  const pending = steps.filter((s) => !s.done).length;

  return (
    <>
      {settings.status === 'draft' && (
        <Alert tone="info">
          <strong>Tu negocio está en preparación.</strong> Configura todo con calma: tu QR todavía no registra
          clientes y las cajas se autorizan cuando Aiment lo publique.
        </Alert>
      )}
      {settings.status === 'live' && pending === 0 && data && (
        <Alert tone="ok">Todo listo: tu programa está funcionando.</Alert>
      )}

      {data && (
        <div className="grid grid-cols-3 gap-2 text-center" data-testid="home-stats">
          {[
            ['Clientes', data.o.stats.customers],
            ['Movimientos (30 días)', data.o.stats.movements30d],
            ['Premios por canjear', data.o.stats.rewardsAvailable],
          ].map(([label, n]) => (
            <div key={label} className="rounded-2xl bg-white p-3 shadow-sm">
              <p className="text-2xl font-bold">{n}</p>
              <p className="text-xs text-gray-500">{label}</p>
            </div>
          ))}
        </div>
      )}

      {data && (
        <Card
          title={pending ? `Configuración: te faltan ${pending}` : 'Configuración completa'}
          testId="checklist"
        >
          <ul className="space-y-1">
            {steps.map((s) => (
              <li key={s.text}>
                <Link
                  to="/panel/$section"
                  params={{ section: s.to }}
                  className="flex min-h-11 items-center gap-3 rounded-xl px-2 hover:bg-gray-50"
                >
                  <span
                    aria-hidden
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sm ${
                      s.done ? 'bg-emerald-600 text-white' : 'border-2 border-gray-300'
                    }`}
                  >
                    {s.done ? '✓' : ''}
                  </span>
                  <span className={s.done ? 'text-gray-500 line-through' : ''}>{s.text}</span>
                  <span className="sr-only">{s.done ? '(hecho)' : '(pendiente)'}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title={`Plan ${settings.plan.name}`} testId="plan-usage">
        <ul className="space-y-1 text-sm">
          <li>
            Sucursales activas:{' '}
            {usageText(settings.usage.branches, settings.limits.branches, 'sucursal', 'sucursales')}
          </li>
          <li>
            Trabajadores de caja:{' '}
            {usageText(settings.usage.staff, settings.limits.staff, 'trabajador', 'trabajadores')}
          </li>
        </ul>
        {role === 'owner' && (
          <p className="mt-2 text-xs text-gray-500">Para ampliar tu plan, escríbele a Aiment.</p>
        )}
      </Card>

      <Card title="Importante sobre la caja">
        <p className="text-sm text-gray-700" data-testid="online-notice">
          La caja necesita <strong>conexión a internet</strong> (Wi-Fi o datos móviles) para sumar, canjear o
          anular. Sin conexión no opera: así se evitan visitas duplicadas y fraudes. Si la señal falla, la
          caja avisa y deja reintentar sin duplicar.
        </p>
      </Card>
    </>
  );
}
