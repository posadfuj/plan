export class EnrollmentError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 410 | 422 | 429,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'EnrollmentError';
  }
}

/** Mismo mensaje para enlace inexistente, vencido o ya usado: no se revela cuál de los tres es. */
export const invalidRecovery = () =>
  new EnrollmentError(410, 'recovery_invalid', 'Este enlace ya no es válido. Pide uno nuevo.');
export const notFound = () => new EnrollmentError(404, 'not_found', 'No encontramos lo que buscas');
