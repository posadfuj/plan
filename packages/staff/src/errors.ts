export class StaffError extends Error {
  constructor(
    readonly status: 401 | 403 | 404 | 409 | 410 | 422 | 429,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'StaffError';
  }
}

export const notFound = () => new StaffError(404, 'not_found', 'Recurso no encontrado');

/** Sin cookie de dispositivo, o el dispositivo fue revocado. */
export const deviceNotAuthorized = () =>
  new StaffError(
    401,
    'device_not_authorized',
    'Este dispositivo no está autorizado como caja. Pide al dueño el QR de autorización.',
  );

/** Turno vencido, cerrado o inexistente. */
export const shiftRequired = () =>
  new StaffError(401, 'shift_required', 'Tu turno terminó. Ingresa de nuevo con tu PIN.');
