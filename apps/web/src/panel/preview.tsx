/** Vista previa de la tarjeta web del cliente con la marca y el programa que se están editando. */
import type { Branding, Card } from '../api';
import { CardView } from '../components/card-view';

export interface ProgramData {
  id: string;
  name: string;
  mode: 'stamps' | 'points';
  unitLabel: string;
  members: number;
  rule: {
    version: number;
    earnRule: { type: 'per_visit'; units: number } | { type: 'per_amount'; amount_per_unit: number };
    goal: number | null;
    welcomeBonus: { type: 'none' } | { type: 'units'; units: number } | { type: 'reward'; reward_id: string };
    limits: {
      cooldown_minutes?: number;
      max_units_per_tx?: number;
      max_amount_per_tx?: number;
      staff_daily_units?: number;
    };
    expirationMonths: number | null;
  } | null;
  rewards: {
    id: string;
    kind: 'goal' | 'catalog' | 'gift';
    name: string;
    description: string | null;
    cost: number | null;
    validityDays: number | null;
    active: boolean;
    sortOrder: number;
  }[];
}

export function previewCard(
  org: { name: string; branding: Branding },
  program: Pick<ProgramData, 'name' | 'mode' | 'unitLabel' | 'rewards'> & { goal: number | null },
): Card {
  const stamps = program.mode === 'stamps';
  const goal = stamps ? Math.max(1, program.goal ?? 10) : null;
  const catalog = program.rewards
    .filter((r) => r.active && r.kind === 'catalog' && r.cost)
    .sort((a, b) => a.cost! - b.cost!);
  const balance = stamps ? Math.min(3, goal! - 1) : Math.max(0, Math.round((catalog[0]?.cost ?? 100) * 0.6));
  const goalReward = program.rewards.find((r) => r.active && r.kind === 'goal');
  const nextCatalog = catalog.find((r) => r.cost! > balance);
  return {
    organization: { id: 'preview', name: org.name, branding: org.branding },
    program: { name: program.name, mode: program.mode, unitLabel: program.unitLabel, goal },
    customer: { name: 'Cliente de ejemplo', memberSince: new Date().toISOString() },
    status: 'active',
    balance,
    progress: stamps
      ? { current: balance, target: goal! }
      : nextCatalog
        ? { current: balance, target: nextCatalog.cost! }
        : null,
    nextReward: stamps
      ? goalReward
        ? { name: goalReward.name, remaining: goal! - balance }
        : null
      : nextCatalog
        ? { name: nextCatalog.name, remaining: nextCatalog.cost! - balance }
        : null,
    redeemable: [],
    scanPath: '/s/vista-previa',
    shortCode: 'ABC234',
    history: [],
    wallet: { apple: { available: false }, google: { available: false } },
  };
}

export function CardPreview({ card }: { card: Card }) {
  return (
    <div className="mx-auto w-full max-w-[360px]">
      <p className="mb-2 text-center text-xs font-semibold uppercase tracking-wide text-gray-500">
        Así la ve tu cliente
      </p>
      <CardView card={card} scanUrl={`${window.location.origin}/s/vista-previa`} preview />
    </div>
  );
}
