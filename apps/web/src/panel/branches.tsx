/**
 * Sucursales: nombre y dirección, su QR y URL para NFC del mostrador, alta dentro del tope del plan,
 * y desactivación (su QR deja de registrar y sus cajas dejan de funcionar).
 */
import { useCallback, useEffect, useState } from 'react';
import { Alert } from '../components/ui';
import { Badge, Card, Field, inputCls, SmallButton, useAction, usageText, usePanel } from './shared';

interface Branch {
  id: string;
  name: string;
  address: string | null;
  status: 'active' | 'inactive';
  linkId: string | null;
  slug: string | null;
  devices: number;
  qrUrl: string | null;
  nfcUrl: string | null;
}

export function BranchesSection() {
  const { call, settings, reload, token, orgId } = usePanel();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [qr, setQr] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const { msg, busy, run } = useAction();

  const load = useCallback(async () => {
    const r = await call<{ branches: Branch[] }>('/branches');
    setBranches(r.branches);
    const urls: Record<string, string> = {};
    for (const b of r.branches.filter((x) => x.linkId && x.status === 'active')) {
      const res = await fetch(`/v1/orgs/${orgId}/links/${b.linkId}/qr?format=png`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.ok) urls[b.id] = URL.createObjectURL(await res.blob());
    }
    setQr((old) => {
      Object.values(old).forEach((u) => URL.revokeObjectURL(u));
      return urls;
    });
  }, [call, orgId, token]);
  useEffect(() => void load(), [load]);

  const refresh = async () => {
    await load();
    await reload();
  };
  const atLimit = settings.limits.branches !== null && settings.usage.branches >= settings.limits.branches;

  return (
    <>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      {settings.status !== 'live' && (
        <Alert tone="info">
          Tu negocio está en preparación: los QR ya se pueden imprimir, pero registran clientes recién al
          publicarlo.
        </Alert>
      )}
      {branches.map((b) =>
        editing === b.id ? (
          <Card key={b.id} title="Editar sucursal">
            <BranchForm
              branch={b}
              busy={busy}
              onCancel={() => setEditing(null)}
              onSave={(body) =>
                void run(async () => {
                  await call(`/branches/${b.id}`, { method: 'PATCH', json: body });
                  setEditing(null);
                  await refresh();
                }, 'Sucursal actualizada.')
              }
            />
          </Card>
        ) : (
          <Card
            key={b.id}
            title={b.name}
            testId="branch-card"
            aside={
              b.status === 'active' ? (
                <Badge tone="green">Activa</Badge>
              ) : (
                <Badge tone="gray">Desactivada</Badge>
              )
            }
          >
            <p className="text-sm text-gray-600">{b.address ?? 'Sin dirección'}</p>
            <p className="text-xs text-gray-500">
              {b.devices} {b.devices === 1 ? 'caja autorizada' : 'cajas autorizadas'}
            </p>
            {b.status === 'active' && b.qrUrl && (
              <>
                {qr[b.id] && (
                  <img src={qr[b.id]} alt={`QR de registro ${b.slug}`} className="mx-auto my-3 h-48 w-48" />
                )}
                <div className="grid grid-cols-2 gap-2">
                  <a
                    className="flex min-h-11 items-center justify-center rounded-xl bg-gray-900 text-sm font-semibold text-white"
                    href={qr[b.id]}
                    download={`qr-${b.slug}.png`}
                  >
                    Descargar QR
                  </a>
                  <SmallButton
                    onClick={() => void navigator.clipboard?.writeText(b.nfcUrl!).then(() => setCopied(b.id))}
                  >
                    {copied === b.id ? '¡Copiada!' : 'Copiar URL para NFC'}
                  </SmallButton>
                </div>
                <p className="mt-2 break-all text-xs text-gray-500">NFC: {b.nfcUrl}</p>
                <p className="break-all text-xs text-gray-500">QR: {b.qrUrl}</p>
              </>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <SmallButton onClick={() => setEditing(b.id)}>Editar</SmallButton>
              {b.status === 'active' ? (
                <SmallButton
                  tone="danger"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await call(`/branches/${b.id}/deactivate`, { method: 'POST' });
                      await refresh();
                    }, `${b.name} desactivada: su QR ya no registra clientes y sus cajas se cerraron.`)
                  }
                >
                  Desactivar
                </SmallButton>
              ) : (
                <SmallButton
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await call(`/branches/${b.id}/reactivate`, { method: 'POST' });
                      await refresh();
                    }, `${b.name} activa de nuevo.`)
                  }
                >
                  Reactivar
                </SmallButton>
              )}
            </div>
          </Card>
        ),
      )}

      <Card
        title="Nueva sucursal"
        aside={
          <span className="text-xs text-gray-500" data-testid="branch-usage">
            {usageText(settings.usage.branches, settings.limits.branches, 'sucursal', 'sucursales')} · plan{' '}
            {settings.plan.name}
          </span>
        }
      >
        {atLimit ? (
          <Alert tone="info">
            Tu plan {settings.plan.name} permite {settings.limits.branches}{' '}
            {settings.limits.branches === 1 ? 'sucursal' : 'sucursales'}. Para abrir otra, pide a Aiment el
            plan Multi.
          </Alert>
        ) : adding ? (
          <BranchForm
            busy={busy}
            onCancel={() => setAdding(false)}
            onSave={(body) =>
              void run(async () => {
                await call('/branches', { method: 'POST', json: body });
                setAdding(false);
                await refresh();
              }, `Sucursal "${body.name}" creada con su propio QR y NFC.`)
            }
          />
        ) : (
          <SmallButton onClick={() => setAdding(true)}>+ Agregar sucursal</SmallButton>
        )}
        <p className="mt-2 text-xs text-gray-500">
          Todas las sucursales comparten el mismo programa y los mismos clientes.
        </p>
      </Card>
    </>
  );
}

function BranchForm({
  branch,
  busy,
  onSave,
  onCancel,
}: {
  branch?: Branch;
  busy: boolean;
  onSave: (body: { name: string; address: string }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(branch?.name ?? '');
  const [address, setAddress] = useState(branch?.address ?? '');
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ name, address });
      }}
    >
      <Field label="Nombre">
        <input
          className={inputCls}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
          required
          placeholder="Ej.: Sede Miraflores"
        />
      </Field>
      <Field label="Dirección">
        <input
          className={inputCls}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          maxLength={160}
          placeholder="Av. Larco 123, Miraflores"
        />
      </Field>
      <div className="flex gap-2">
        <SmallButton type="submit" tone="primary" disabled={busy} className="flex-1">
          Guardar
        </SmallButton>
        <SmallButton onClick={onCancel} className="flex-1">
          Cancelar
        </SmallButton>
      </div>
    </form>
  );
}
