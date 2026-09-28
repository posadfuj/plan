export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500 | 503,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

/** 404 genérico: no revela si el recurso existe en otra organización. */
export const notFound = () => new HttpError(404, 'not_found', 'Recurso no encontrado');
