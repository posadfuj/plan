export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 500,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

/** 404 genérico: no revela si el recurso existe en otra organización. */
export const notFound = () => new HttpError(404, 'not_found', 'Recurso no encontrado');
