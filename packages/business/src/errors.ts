export class BusinessError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 413 | 415 | 422 | 503,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'BusinessError';
  }
}

export const notFound = () => new BusinessError(404, 'not_found', 'Recurso no encontrado');

/** Quién hace el cambio desde el panel (dueño/admin) o desde el panel maestro (superadmin). */
export interface Editor {
  orgUserId: string;
  actorType: 'owner';
}
