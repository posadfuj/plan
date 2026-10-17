import { isCardMessageCurrent, type AutomationKey } from '@aiment/core';
import { schema, type Tx } from '@aiment/db';
import { and, desc, eq, sql } from 'drizzle-orm';

const { automationRuns, automations, earnedRewards, rewards } = schema;

export interface CardMessage {
  key: AutomationKey;
  text: string;
}

/**
 * Último mensaje automático vigente (bienvenida, meta alcanzada, te falta poco). Lo muestran la
 * tarjeta web y el pase de Wallet: una sola regla para los dos.
 */
export async function loadCardMessage(
  tx: Tx,
  m: {
    membershipId: string;
    programId: string;
    status: string;
    mode: 'stamps' | 'points';
    balance: number;
    goal: number | null;
  },
  now = new Date(),
): Promise<CardMessage | null> {
  if (m.status !== 'active') return null;
  const [last] = await tx
    .select({ result: automationRuns.result, createdAt: automationRuns.createdAt })
    .from(automationRuns)
    .innerJoin(automations, eq(automations.id, automationRuns.automationId))
    .where(
      and(
        eq(automationRuns.membershipId, m.membershipId),
        eq(automationRuns.status, 'done'),
        eq(automations.enabled, true),
      ),
    )
    // Una misma operación puede dejar varios (1.ª visita que completa la meta): gana el más importante.
    .orderBy(
      desc(automationRuns.createdAt),
      sql`case ${automationRuns.result}->>'key' when 'goal_reached' then 0 when 'almost_there' then 1 else 2 end`,
    )
    .limit(1);
  const r = last?.result as ({ key: AutomationKey; message: string } & Record<string, unknown>) | undefined;
  if (!r) return null;

  const rewardList = await tx
    .select({ id: rewards.id, name: rewards.name, kind: rewards.kind, cost: rewards.cost })
    .from(rewards)
    .where(and(eq(rewards.programId, m.programId), eq(rewards.active, true)));
  const available = await tx
    .select({ id: earnedRewards.id })
    .from(earnedRewards)
    .where(and(eq(earnedRewards.membershipId, m.membershipId), eq(earnedRewards.status, 'available')));
  const current = isCardMessageCurrent(
    { key: r.key, message: r.message, data: r, createdAt: last!.createdAt },
    {
      mode: m.mode,
      balance: m.balance,
      goal: m.goal,
      goalRewardName: rewardList.find((x) => x.kind === 'goal')?.name ?? null,
      catalog: rewardList
        .filter((x) => x.kind === 'catalog' && x.cost !== null)
        .map((x) => ({ id: x.id, name: x.name, cost: x.cost! })),
      availableEarnedRewardIds: available.map((a) => a.id),
    },
    now,
  );
  return current ? { key: r.key, text: r.message } : null;
}
