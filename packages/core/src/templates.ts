/**
 * Plantillas por rubro: puntos de partida editables para configurar el programa sin tocar código.
 * Aplicar una plantilla solo crea una versión de regla y premios iniciales; después el dueño edita todo.
 */
import type { ProgramMode, RuleInput } from './loyalty/rules';

export interface TemplateReward {
  kind: 'goal' | 'catalog';
  name: string;
  cost?: number;
  validityDays?: number;
}

export interface ProgramTemplate {
  key: string;
  label: string;
  mode: ProgramMode;
  unitLabel: string;
  primaryColor: string;
  rule: RuleInput;
  rewards: TemplateReward[];
}

const visitLimits = { cooldown_minutes: 240, max_units_per_tx: 1, staff_daily_units: 200 };
const stamps = (
  goal: number,
  reward: string,
  validityDays = 90,
): Omit<ProgramTemplate, 'key' | 'label' | 'primaryColor'> => ({
  mode: 'stamps',
  unitLabel: 'sellos',
  rule: { earnRule: { type: 'per_visit', units: 1 }, goal, limits: visitLimits, expirationMonths: null },
  rewards: [{ kind: 'goal', name: reward, validityDays }],
});
const points = (
  maxAmount: number,
  catalog: [string, number][],
): Omit<ProgramTemplate, 'key' | 'label' | 'primaryColor'> => ({
  mode: 'points',
  unitLabel: 'puntos',
  rule: {
    earnRule: { type: 'per_amount', amount_per_unit: 1, rounding: 'floor' },
    goal: null,
    limits: { max_amount_per_tx: maxAmount, staff_daily_units: 5000 },
    expirationMonths: null,
  },
  rewards: catalog.map(([name, cost]) => ({ kind: 'catalog', name, cost })),
});

export const PROGRAM_TEMPLATES: readonly ProgramTemplate[] = [
  { key: 'barberia', label: 'Barbería', primaryColor: '#1F2937', ...stamps(10, 'Corte gratis') },
  {
    key: 'salon',
    label: 'Salón de belleza / spa',
    primaryColor: '#9D174D',
    ...stamps(8, 'Tratamiento gratis'),
  },
  {
    key: 'veterinaria',
    label: 'Veterinaria / pet shop',
    primaryColor: '#0F766E',
    ...stamps(6, 'Baño gratis'),
  },
  {
    key: 'lavanderia',
    label: 'Lavandería / lavado de autos',
    primaryColor: '#1D4ED8',
    ...stamps(8, 'Lavado gratis'),
  },
  {
    key: 'cafeteria',
    label: 'Cafetería / panadería',
    primaryColor: '#6B3E26',
    ...points(500, [
      ['Café americano', 50],
      ['Capuccino', 80],
      ['Postre de la casa', 120],
    ]),
  },
  {
    key: 'restaurante',
    label: 'Restaurante',
    primaryColor: '#B91C1C',
    ...points(1000, [
      ['Bebida de cortesía', 40],
      ['Postre', 80],
      ['Plato de fondo', 200],
    ]),
  },
  {
    key: 'tienda',
    label: 'Tienda / minimarket',
    primaryColor: '#047857',
    ...points(1000, [
      ['Vale de S/ 10', 150],
      ['Vale de S/ 25', 350],
    ]),
  },
  { key: 'otro', label: 'Otro rubro (sellos)', primaryColor: '#374151', ...stamps(10, 'Premio de la casa') },
];

export function findTemplate(key: unknown): ProgramTemplate | undefined {
  return PROGRAM_TEMPLATES.find((t) => t.key === key);
}
