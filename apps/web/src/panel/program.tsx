/**
 * Programa: plantilla por rubro (solo antes del primer cliente), nombre y unidades, regla (cuánto se suma,
 * meta, bienvenida, límites; expiración desactivada en el piloto) y premios. Cada cambio de regla crea
 * una versión nueva: los movimientos anteriores conservan la suya.
 */
import { PROGRAM_TEMPLATES } from '@aiment/core/templates';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert } from '../components/ui';
import { CardPreview, previewCard, type ProgramData } from './preview';
import { Badge, Card, Field, inputCls, SmallButton, useAction, usePanel } from './shared';

type Reward = ProgramData['rewards'][number];
const num = (v: string) => (v.trim() === '' ? undefined : Number(v));

export function ProgramSection() {
  const { call, settings } = usePanel();
  const [program, setProgram] = useState<ProgramData | null>(null);
  // La confirmación vive aquí: el formulario de la regla se vuelve a crear con cada versión nueva.
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(() => call<ProgramData>('/program').then(setProgram), [call]);
  useEffect(() => void load(), [load]);
  if (!program?.rule) return null;
  return (
    <div className="grid gap-4 md:grid-cols-[1fr_320px]">
      <div className="space-y-4">
        {program.members === 0 && <TemplatePicker onApplied={load} />}
        <ProgramBasics key={`${program.name}/${program.unitLabel}`} program={program} onSaved={load} />
        {notice && <Alert tone="ok">{notice}</Alert>}
        <RuleForm
          key={program.rule.version}
          program={program}
          onSaved={async () => {
            await load();
            setNotice('Regla guardada. Se aplica desde la próxima operación; lo anterior conserva su regla.');
          }}
        />
        <Rewards program={program} onSaved={load} />
      </div>
      <aside className="md:sticky md:top-16 md:self-start">
        <CardPreview card={previewCard(settings, { ...program, goal: program.rule.goal })} />
      </aside>
    </div>
  );
}

function TemplatePicker({ onApplied }: { onApplied: () => Promise<unknown> }) {
  const { call } = usePanel();
  const [key, setKey] = useState('');
  const { msg, busy, run } = useAction();
  const t = PROGRAM_TEMPLATES.find((x) => x.key === key);
  return (
    <Card title="Empieza con una plantilla de tu rubro" testId="template-picker">
      <p className="mb-3 text-sm text-gray-600">
        Carga una regla y premios típicos para tu tipo de negocio. Después puedes cambiar todo. Solo está
        disponible mientras no tengas clientes.
      </p>
      <div className="flex gap-2">
        <select aria-label="Rubro" className={inputCls} value={key} onChange={(e) => setKey(e.target.value)}>
          <option value="">Elige tu rubro…</option>
          {PROGRAM_TEMPLATES.map((x) => (
            <option key={x.key} value={x.key}>
              {x.label} · {x.mode === 'stamps' ? 'sellos' : 'puntos'}
            </option>
          ))}
        </select>
        <SmallButton
          tone="primary"
          disabled={!t || busy}
          onClick={() =>
            void run(async () => {
              await call('/program/template', { method: 'POST', json: { template: key } });
              await onApplied();
            }, `Plantilla «${t!.label}» aplicada.`)
          }
        >
          Aplicar
        </SmallButton>
      </div>
      {t && (
        <p className="mt-2 text-xs text-gray-500">
          {t.mode === 'stamps'
            ? `${t.rule.goal} sellos = ${t.rewards[0]!.name}. 1 sello por visita, como máximo uno cada 4 horas.`
            : `S/ 1 = 1 punto. Premios: ${t.rewards.map((r) => `${r.name} (${r.cost})`).join(', ')}.`}
        </p>
      )}
      {msg && (
        <div className="mt-3">
          <Alert tone={msg.tone}>{msg.text}</Alert>
        </div>
      )}
    </Card>
  );
}

function ProgramBasics({ program, onSaved }: { program: ProgramData; onSaved: () => Promise<unknown> }) {
  const { call } = usePanel();
  const [name, setName] = useState(program.name);
  const [unit, setUnit] = useState(program.unitLabel);
  const { msg, busy, run } = useAction();
  return (
    <Card
      title="Nombre del programa"
      aside={<Badge tone="gray">{program.mode === 'stamps' ? 'Sellos' : 'Puntos'}</Badge>}
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await call('/program', { method: 'PATCH', json: { name, unitLabel: unit } });
            await onSaved();
          }, 'Programa actualizado.');
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Nombre">
            <input
              className={inputCls}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              required
            />
          </Field>
          <Field label="¿Cómo se llaman las unidades?" hint='En plural: "sellos", "puntos", "cafecitos"…'>
            <input
              className={inputCls}
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              maxLength={20}
              required
            />
          </Field>
        </div>
        <SmallButton type="submit" tone="primary" disabled={busy}>
          Guardar nombre
        </SmallButton>
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      </form>
    </Card>
  );
}

function RuleForm({ program, onSaved }: { program: ProgramData; onSaved: () => Promise<unknown> }) {
  const { call } = usePanel();
  const r = program.rule!;
  const stamps = program.mode === 'stamps';
  const gifts = program.rewards.filter((x) => x.kind === 'gift' && x.active);
  const [f, setF] = useState({
    units: String(r.earnRule.type === 'per_visit' ? r.earnRule.units : 1),
    amountPerUnit: String(r.earnRule.type === 'per_amount' ? r.earnRule.amount_per_unit : 1),
    goal: String(r.goal ?? ''),
    welcome: r.welcomeBonus.type,
    welcomeUnits: String(r.welcomeBonus.type === 'units' ? r.welcomeBonus.units : 1),
    welcomeReward: r.welcomeBonus.type === 'reward' ? r.welcomeBonus.reward_id : (gifts[0]?.id ?? ''),
    cooldown: String(r.limits.cooldown_minutes ?? ''),
    maxUnits: String(r.limits.max_units_per_tx ?? ''),
    maxAmount: String(r.limits.max_amount_per_tx ?? ''),
    daily: String(r.limits.staff_daily_units ?? ''),
  });
  const { msg, busy, run } = useAction();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));

  function save(e: FormEvent) {
    e.preventDefault();
    const limits = Object.fromEntries(
      Object.entries({
        cooldown_minutes: num(f.cooldown),
        max_units_per_tx: num(f.maxUnits),
        max_amount_per_tx: stamps ? undefined : num(f.maxAmount),
        staff_daily_units: num(f.daily),
      }).filter(([, v]) => v !== undefined),
    );
    void run(async () => {
      const out = await call<{ version: number }>('/program/rules', {
        method: 'POST',
        json: {
          earnRule: stamps
            ? { type: 'per_visit', units: Number(f.units) }
            : { type: 'per_amount', amount_per_unit: Number(f.amountPerUnit), rounding: 'floor' },
          goal: stamps ? Number(f.goal) : null,
          welcomeBonus:
            f.welcome === 'units'
              ? { type: 'units', units: Number(f.welcomeUnits) }
              : f.welcome === 'reward'
                ? { type: 'reward', reward_id: f.welcomeReward }
                : { type: 'none' },
          limits,
          expirationMonths: null,
        },
      });
      await onSaved();
      return out;
    });
  }

  return (
    <Card
      title="Regla"
      aside={<span className="text-xs text-gray-500">versión {r.version}</span>}
      testId="rule-form"
    >
      <form className="space-y-4" onSubmit={save}>
        <div className="grid gap-3 sm:grid-cols-2">
          {stamps ? (
            <>
              <Field label={`${program.unitLabel} por visita`}>
                <input
                  className={inputCls}
                  type="number"
                  min={1}
                  max={100}
                  value={f.units}
                  onChange={set('units')}
                  required
                />
              </Field>
              <Field label={`Meta (${program.unitLabel} para el premio)`}>
                <input
                  className={inputCls}
                  type="number"
                  min={1}
                  max={1000}
                  value={f.goal}
                  onChange={set('goal')}
                  required
                />
              </Field>
            </>
          ) : (
            <Field label="Soles por cada punto" hint="1 = cada S/ 1 suma 1 punto (se redondea hacia abajo).">
              <input
                className={inputCls}
                type="number"
                min={0.1}
                step="0.1"
                max={10000}
                value={f.amountPerUnit}
                onChange={set('amountPerUnit')}
                required
              />
            </Field>
          )}
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Bienvenida (en la 1.ª visita validada en caja)</legend>
          <select
            aria-label="Tipo de bienvenida"
            className={inputCls}
            value={f.welcome}
            onChange={set('welcome')}
          >
            <option value="none">Sin bono</option>
            <option value="units">{program.unitLabel} de regalo</option>
            <option value="reward" disabled={!gifts.length}>
              Un regalo {gifts.length ? '' : '(crea antes un premio de tipo regalo)'}
            </option>
          </select>
          {f.welcome === 'units' && (
            <input
              aria-label="Unidades de bienvenida"
              className={inputCls}
              type="number"
              min={1}
              max={100}
              value={f.welcomeUnits}
              onChange={set('welcomeUnits')}
            />
          )}
          {f.welcome === 'reward' && (
            <select
              aria-label="Regalo de bienvenida"
              className={inputCls}
              value={f.welcomeReward}
              onChange={set('welcomeReward')}
            >
              {gifts.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          )}
        </fieldset>

        <details className="rounded-xl bg-gray-50 p-3" open>
          <summary className="cursor-pointer text-sm font-medium">Límites contra errores y abusos</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field
              label="Minutos entre dos sumas al mismo cliente"
              hint="Ej.: 240 = una vez cada 4 horas. Vacío = sin límite."
            >
              <input
                className={inputCls}
                type="number"
                min={1}
                max={10080}
                value={f.cooldown}
                onChange={set('cooldown')}
              />
            </Field>
            <Field label={`Máximo de ${program.unitLabel} por operación`}>
              <input
                className={inputCls}
                type="number"
                min={1}
                max={100000}
                value={f.maxUnits}
                onChange={set('maxUnits')}
              />
            </Field>
            {!stamps && (
              <Field label="Monto máximo por compra (S/)">
                <input
                  className={inputCls}
                  type="number"
                  min={1}
                  max={1000000}
                  value={f.maxAmount}
                  onChange={set('maxAmount')}
                />
              </Field>
            )}
            <Field label={`Tope diario por trabajador (${program.unitLabel})`}>
              <input
                className={inputCls}
                type="number"
                min={1}
                max={1000000}
                value={f.daily}
                onChange={set('daily')}
              />
            </Field>
          </div>
          <p className="mt-2 text-xs text-gray-500">
            Si se supera un límite, la caja pide tu PIN para autorizar la excepción y queda registrado.
          </p>
        </details>

        <label className="flex items-center gap-3 text-sm text-gray-500">
          <input type="checkbox" disabled checked={false} readOnly className="h-5 w-5" />
          Vencimiento por inactividad: desactivado durante el piloto
        </label>

        <SmallButton type="submit" tone="primary" disabled={busy} className="w-full">
          {busy ? 'Guardando…' : 'Guardar regla'}
        </SmallButton>
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      </form>
    </Card>
  );
}

const KIND_LABEL: Record<Reward['kind'], string> = {
  goal: 'Premio de la meta',
  catalog: 'Catálogo',
  gift: 'Regalo',
};

function Rewards({ program, onSaved }: { program: ProgramData; onSaved: () => Promise<unknown> }) {
  const { call } = usePanel();
  const stamps = program.mode === 'stamps';
  const { msg, busy, run } = useAction();
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const sorted = [...program.rewards].sort(
    (a, b) => Number(b.active) - Number(a.active) || a.sortOrder - b.sortOrder,
  );

  const save = (id: string | null, body: Record<string, unknown>) =>
    run(async () => {
      if (id) await call(`/rewards/${id}`, { method: 'PATCH', json: body });
      else await call('/rewards', { method: 'POST', json: body });
      setEditing(null);
      setAdding(false);
      await onSaved();
    }, 'Premio guardado.');

  return (
    <Card title="Premios" testId="rewards">
      <ul className="divide-y divide-gray-100">
        {sorted.map((r) =>
          editing === r.id ? (
            <li key={r.id} className="py-3">
              <RewardForm
                reward={r}
                points={!stamps}
                busy={busy}
                onCancel={() => setEditing(null)}
                onSave={(b) => void save(r.id, b)}
              />
            </li>
          ) : (
            <li
              key={r.id}
              className={`flex items-center justify-between gap-2 py-3 ${r.active ? '' : 'opacity-50'}`}
            >
              <div className="min-w-0">
                <p className="font-medium">
                  {r.name} {!r.active && <Badge tone="gray">Desactivado</Badge>}
                </p>
                <p className="text-xs text-gray-500">
                  {KIND_LABEL[r.kind]}
                  {r.cost ? ` · ${r.cost} ${program.unitLabel}` : ''}
                  {r.validityDays ? ` · vence a los ${r.validityDays} días` : ''}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <SmallButton onClick={() => setEditing(r.id)}>Editar</SmallButton>
                <SmallButton disabled={busy} onClick={() => void save(r.id, { active: !r.active })}>
                  {r.active ? 'Desactivar' : 'Activar'}
                </SmallButton>
              </div>
            </li>
          ),
        )}
      </ul>
      {adding ? (
        <div className="mt-3 rounded-xl bg-gray-50 p-3">
          <RewardForm
            points={!stamps}
            busy={busy}
            onCancel={() => setAdding(false)}
            onSave={(b) => void save(null, b)}
          />
        </div>
      ) : (
        <SmallButton className="mt-3" onClick={() => setAdding(true)}>
          + Agregar premio
        </SmallButton>
      )}
      <p className="mt-2 text-xs text-gray-500">
        {stamps
          ? 'Solo un premio de meta activo a la vez. Los regalos sirven como bono de bienvenida.'
          : 'El catálogo se canjea con puntos en caja. Los regalos sirven como bono de bienvenida.'}
      </p>
      {msg && (
        <div className="mt-3">
          <Alert tone={msg.tone}>{msg.text}</Alert>
        </div>
      )}
    </Card>
  );
}

function RewardForm({
  reward,
  points,
  busy,
  onSave,
  onCancel,
}: {
  reward?: Reward;
  points: boolean;
  busy: boolean;
  onSave: (body: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<Reward['kind']>(reward?.kind ?? (points ? 'catalog' : 'goal'));
  const [name, setName] = useState(reward?.name ?? '');
  const [cost, setCost] = useState(String(reward?.cost ?? ''));
  const [days, setDays] = useState(String(reward?.validityDays ?? ''));
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          ...(reward ? {} : { kind }),
          name,
          ...(kind === 'catalog' ? { cost: Number(cost) } : {}),
          validityDays: days.trim() ? Number(days) : null,
        });
      }}
    >
      {!reward && (
        <select
          aria-label="Tipo de premio"
          className={inputCls}
          value={kind}
          onChange={(e) => setKind(e.target.value as Reward['kind'])}
        >
          {points ? (
            <option value="catalog">Catálogo (se canjea con puntos)</option>
          ) : (
            <option value="goal">Premio de la meta</option>
          )}
          <option value="gift">Regalo (bienvenida)</option>
        </select>
      )}
      <input
        aria-label="Nombre del premio"
        className={inputCls}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Nombre del premio"
        maxLength={80}
        required
      />
      {kind === 'catalog' && (
        <input
          aria-label="Costo en puntos"
          className={inputCls}
          type="number"
          min={1}
          value={cost}
          onChange={(e) => setCost(e.target.value)}
          placeholder="Costo en puntos"
          required
        />
      )}
      <input
        aria-label="Días de vigencia"
        className={inputCls}
        type="number"
        min={1}
        max={730}
        value={days}
        onChange={(e) => setDays(e.target.value)}
        placeholder="Días de vigencia (opcional)"
      />
      <div className="flex gap-2">
        <SmallButton type="submit" tone="primary" disabled={busy} className="flex-1">
          Guardar premio
        </SmallButton>
        <SmallButton onClick={onCancel} className="flex-1">
          Cancelar
        </SmallButton>
      </div>
    </form>
  );
}
