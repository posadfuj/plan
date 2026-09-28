/** Cajas: autorizar el celular o tablet de cada sucursal con un QR de un solo uso, y revocarlos. */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert } from '../components/ui';
import { Badge, Card, fmtDateTime, inputCls, SmallButton, useAction, usePanel } from './shared';
import type { BranchRow } from './team';

interface DeviceRow {
  id: string;
  name: string;
  branchId: string;
  branch: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  shift: { name: string; since: string } | null;
}

export function DevicesSection() {
  const { call, settings } = usePanel();
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [branchId, setBranchId] = useState('');
  const [pairing, setPairing] = useState<{ url: string; qrSvg: string; expiresAt: string } | null>(null);
  const { msg, busy, run } = useAction();
  const live = settings.status === 'live';

  const load = useCallback(async () => {
    const [d, b] = await Promise.all([
      call<{ devices: DeviceRow[] }>('/devices'),
      call<{ branches: BranchRow[] }>('/branches'),
    ]);
    setDevices(d.devices);
    const active = b.branches.filter((x) => x.status === 'active');
    setBranches(active);
    setBranchId((cur) => cur || active[0]?.id || '');
  }, [call]);
  useEffect(() => void load(), [load]);

  function authorize(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get('name') ?? '');
    void run(async () => {
      setPairing(
        await call('/devices/pairings', {
          method: 'POST',
          json: { name, ...(branchId ? { branchId } : {}) },
        }),
      );
    });
  }

  const active = devices.filter((d) => !d.revokedAt);
  const revoked = devices.filter((d) => d.revokedAt);

  return (
    <div className="space-y-4" data-testid="register-admin">
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <Card title="Autorizar un dispositivo de caja">
        <p className="text-sm text-gray-600">
          Genera un QR de un solo uso (vence en 10 minutos) y escanéalo con el celular o tablet de la caja.
          Queda autorizado 180 días o hasta que lo revoques.
        </p>
        {!live && (
          <div className="mt-3">
            <Alert tone="info">Las cajas se autorizan cuando Aiment publique tu negocio.</Alert>
          </div>
        )}
        <form className="mt-3 space-y-2" onSubmit={authorize}>
          <input
            name="name"
            required
            placeholder="Ej.: Celular del mostrador"
            maxLength={40}
            className={inputCls}
            disabled={!live}
          />
          {branches.length > 1 && (
            <select
              aria-label="Sucursal de la caja"
              className={inputCls}
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
            >
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
          <SmallButton type="submit" tone="primary" disabled={!live || busy} className="w-full">
            Generar QR
          </SmallButton>
        </form>
        {pairing && (
          <div className="mt-4 text-center" data-testid="pairing-qr">
            <div
              className="mx-auto h-56 w-56 [&>svg]:h-full [&>svg]:w-full"
              dangerouslySetInnerHTML={{ __html: pairing.qrSvg }}
            />
            <p className="mt-2 text-xs text-gray-500">
              Un solo uso · vence {new Date(pairing.expiresAt).toLocaleTimeString('es-PE')}
            </p>
            <a href={pairing.url} className="mt-2 inline-block text-sm font-semibold underline">
              Usar ESTE dispositivo como caja
            </a>
            <SmallButton className="ml-3" onClick={() => void load()}>
              Ya lo escaneé
            </SmallButton>
          </div>
        )}
        <p className="mt-3 text-xs text-gray-500">
          La caja necesita internet (Wi-Fi o datos). No funciona sin conexión: así no se duplican visitas.
        </p>
      </Card>

      <Card title={`Cajas autorizadas (${active.length})`} testId="devices-list">
        <ul className="divide-y divide-gray-100">
          {active.map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-2 py-3 text-sm">
              <span className="min-w-0">
                <strong>{d.name}</strong> <span className="text-gray-500">· {d.branch}</span>
                <span className="block text-xs text-gray-500">
                  {d.shift ? (
                    <>
                      <Badge tone="green">De turno</Badge> {d.shift.name} desde {fmtDateTime(d.shift.since)}
                    </>
                  ) : d.lastSeenAt ? (
                    `Último uso: ${fmtDateTime(d.lastSeenAt)}`
                  ) : (
                    'Sin uso'
                  )}
                </span>
              </span>
              <SmallButton
                tone="danger"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await call(`/devices/${d.id}/revoke`, { method: 'POST' });
                    await load();
                  }, `"${d.name}" ya no puede usarse como caja.`)
                }
              >
                Revocar
              </SmallButton>
            </li>
          ))}
          {!active.length && <li className="py-3 text-sm text-gray-500">Ninguna caja autorizada todavía.</li>}
        </ul>
        {revoked.length > 0 && (
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-gray-600">Revocadas ({revoked.length})</summary>
            <ul className="mt-2 space-y-1 text-gray-400">
              {revoked.map((d) => (
                <li key={d.id} className="line-through">
                  {d.name} · {d.branch}
                </li>
              ))}
            </ul>
          </details>
        )}
      </Card>
    </div>
  );
}
