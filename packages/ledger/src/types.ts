import type { LoyaltyError } from '@aiment/core';

/** Quién ejecuta la operación. La API calcula los permisos con `can()` y los pasa como flags. */
export interface Operator {
  /** 'owner' = gestión del negocio (dueño o admin); 'staff' = caja. */
  actorType: 'owner' | 'staff';
  orgUserId: string;
  deviceId?: string | null;
  branchId?: string | null;
  canVoidAny: boolean;
  canOverrideLimits: boolean;
}

/** Errores del servicio que no son reglas de negocio (recurso inexistente, clave reutilizada). */
export class ServiceError extends Error {
  constructor(
    readonly status: 404 | 409 | 422,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

export type { LoyaltyError };

/** Clave de idempotencia enviada por el cliente (una por intención de operación, no por clic). */
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{8,100}$/;

export function assertIdempotencyKey(key: string | undefined): asserts key is string {
  if (!key || !IDEMPOTENCY_KEY_RE.test(key))
    throw new ServiceError(
      422,
      'idempotency_key_required',
      'Falta la clave de idempotencia (8–100 caracteres: letras, números, guion o guion bajo)',
    );
}

export interface EntryDTO {
  id: string;
  kind: string;
  delta: number;
  balanceAfter: number;
  createdAt: Date;
  reversesEntryId: string | null;
  causedByEntryId: string | null;
}

export interface EarnedRewardDTO {
  id: string;
  rewardId: string;
  name: string;
  source: string;
  status: string;
  expiresAt: Date | null;
}

export interface MembershipState {
  id: string;
  balance: number;
  lifetimeEarned: number;
  status: string;
  firstValidatedAt: Date | null;
  lastActivityAt: Date | null;
  availableRewards: EarnedRewardDTO[];
}

export interface OperationResult {
  operation: 'earn' | 'redeem' | 'adjust' | 'void' | 'void_redemption';
  /** true = la misma clave ya se había procesado; no se repitió nada. */
  replayed: boolean;
  entries: EntryDTO[];
  earnedRewards: EarnedRewardDTO[];
  redemption: { id: string; rewardId: string; status: string } | null;
  overriddenLimits: string[];
  /** Estado actual de la membresía (leído de la base). */
  membership: MembershipState;
}
