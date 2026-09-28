/** Errores de negocio del motor. La API los traduce a respuestas 409/422 con el mismo código. */
export const LOYALTY_ERRORS = {
  invalid_rule: 'La regla del programa no es válida',
  amount_required: 'Ingresa el monto de la compra',
  invalid_amount: 'El monto debe ser un número positivo con hasta 2 decimales',
  amount_too_low: 'El monto no alcanza para sumar puntos',
  cooldown_active: 'Este cliente ya sumó hace poco',
  max_units_per_tx: 'Se supera el máximo por operación',
  max_amount_per_tx: 'El monto supera el máximo permitido por operación',
  staff_daily_units: 'Se superó el tope diario de este usuario',
  membership_inactive: 'La membresía no está activa',
  insufficient_balance: 'Saldo insuficiente para este premio',
  reward_not_available: 'El premio no está disponible',
  reward_expired: 'El premio venció',
  reward_inactive: 'El premio está desactivado',
  not_voidable: 'Este tipo de movimiento no se puede anular',
  already_voided: 'Este movimiento ya fue anulado',
  void_not_own: 'Solo puedes anular tus propios movimientos',
  void_not_latest: 'Solo puedes anular tu último movimiento de este cliente',
  void_window_expired: 'Pasó el tiempo permitido para anular',
  reward_already_redeemed: 'El premio que generó este movimiento ya fue canjeado; anula primero el canje',
  balance_would_be_negative: 'La operación dejaría el saldo en negativo',
  invalid_adjustment: 'El ajuste no es válido',
  reason_required: 'Indica el motivo',
} as const;

export type LoyaltyErrorCode = keyof typeof LOYALTY_ERRORS;

export class LoyaltyError extends Error {
  constructor(
    readonly code: LoyaltyErrorCode,
    readonly details: Record<string, unknown> = {},
    message: string = LOYALTY_ERRORS[code],
  ) {
    super(message);
    this.name = 'LoyaltyError';
  }
}
