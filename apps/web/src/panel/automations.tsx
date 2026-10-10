/**
 * Mensajes automáticos en la tarjeta del cliente (semana 6): bienvenida, premio ganado y "te falta poco".
 * Se activan o desactivan uno por uno; "te falta poco" tiene umbral configurable.
 * El bono de bienvenida (sellos o regalo) se configura en la regla; aquí solo el mensaje.
 */
import { useCallback, useEffect, useState } from 'react';
import { Alert } from '../components/ui';
import { Badge, Card, inputCls, SmallButton, useAction, usePanel } from './shared';

type Key = 'welcome' | 'goal_reached' | 'almost_there';
interface Automations {
  available: boolean;
  mode: 'stamps' | 'points';
  automations: { key: Key; enabled: boolean; config: { threshold?: number }; runsLast30Days: number }[];
}

const INFO: Record<Key, { title: string; when: (stamps: boolean) => string }> = {
  welcome: {
    title: 'Bienvenida',
    when: () => 'En la primera visita. Si la regla da un bono de bienvenida, el mensaje lo menciona.',
  },
  goal_reached: {
    title: 'Premio ganado',
    when: (stamps) =>
      stamps
        ? 'Cuando completa la tarjeta: le dice qué ganó y que lo pida en caja.'
        : 'Cuando ya le alcanza para un premio del catálogo.',
  },
  almost_there: {
    title: 'Te falta poco',
    when: (stamps) =>
      stamps
        ? 'Cuando le falta poco para el premio (por defecto, 1 sello).'
        : 'Cuando está cerca del próximo premio.',
  },
};

export function AutomationsCard() {
  const { call } = usePanel();
  const [data, setData] = useState<Automations | null>(null);
  const { msg, busy, run } = useAction();
  const load = useCallback(() => call<Automations>('/automations').then(setData), [call]);
  useEffect(() => void load().catch(() => setData(null)), [load]);
  if (!data) return null;
  const stamps = data.mode === 'stamps';

  const save = (key: Key, body: { enabled?: boolean; threshold?: number | null }, ok: string) =>
    run(
      async () => setData(await call<Automations>(`/automations/${key}`, { method: 'PATCH', json: body })),
      ok,
    );

  return (
    <Card title="Mensajes automáticos" testId="automations">
      <p className="text-sm text-gray-600">
        Aparecen en la tarjeta del cliente (y, cuando llegue Wallet, también en su pase).
      </p>
      {!data.available && (
        <div className="mt-3">
          <Alert tone="info">
            Incluidos desde el plan Pro. Para activarlos, pide a Aiment el cambio de plan.
          </Alert>
        </div>
      )}
      {msg && (
        <div className="mt-3">
          <Alert tone={msg.tone}>{msg.text}</Alert>
        </div>
      )}
      <ul className="mt-3 divide-y divide-gray-100">
        {data.automations.map((a) => (
          <li key={a.key} className="py-3" data-testid={`automation-${a.key}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-semibold">
                  {INFO[a.key].title}{' '}
                  {data.available && (
                    <Badge tone={a.enabled ? 'green' : 'gray'}>{a.enabled ? 'Activo' : 'Apagado'}</Badge>
                  )}
                </p>
                <p className="text-sm text-gray-600">{INFO[a.key].when(stamps)}</p>
                {data.available && (
                  <p className="text-xs text-gray-500">{a.runsLast30Days} enviados en los últimos 30 días</p>
                )}
              </div>
              <SmallButton
                disabled={!data.available || busy}
                onClick={() =>
                  void save(
                    a.key,
                    { enabled: !a.enabled },
                    a.enabled ? 'Mensaje apagado.' : 'Mensaje activado.',
                  )
                }
                aria-label={`${a.enabled ? 'Apagar' : 'Activar'} ${INFO[a.key].title}`}
              >
                {a.enabled ? 'Apagar' : 'Activar'}
              </SmallButton>
            </div>
            {a.key === 'almost_there' && data.available && a.enabled && (
              <ThresholdForm
                value={a.config.threshold ?? null}
                stamps={stamps}
                busy={busy}
                onSave={(threshold) => void save('almost_there', { threshold }, 'Umbral guardado.')}
              />
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ThresholdForm({
  value,
  stamps,
  busy,
  onSave,
}: {
  value: number | null;
  stamps: boolean;
  busy: boolean;
  onSave: (threshold: number | null) => void;
}) {
  const [text, setText] = useState(value ? String(value) : '');
  return (
    <form
      className="mt-2 flex items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(Number(text) || null); // vacío o 0 → umbral por defecto
      }}
    >
      <label className="block flex-1">
        <span className="text-xs font-medium">Avisar cuando falten (o menos)</span>
        <input
          className={`${inputCls} mt-1`}
          inputMode="numeric"
          value={text}
          onChange={(e) => setText(e.target.value.replace(/\D/g, '').slice(0, 4))}
          placeholder={stamps ? '1 (por defecto)' : '10 % del premio (por defecto)'}
          aria-label="Umbral de te falta poco"
        />
      </label>
      <SmallButton type="submit" disabled={busy}>
        Guardar
      </SmallButton>
    </form>
  );
}
