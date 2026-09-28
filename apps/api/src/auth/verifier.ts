import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from 'jose';
import { HttpError } from '../errors';

export interface AuthClaims {
  userId: string;
  email?: string;
  /** Nivel de autenticación de Supabase: aal2 = contraseña + TOTP. */
  aal: 'aal1' | 'aal2';
}

export interface TokenVerifier {
  verify(token: string): Promise<AuthClaims>;
}

/**
 * Valida access tokens de Supabase Auth.
 * - Claves asimétricas (producción): JWKS publicado por Supabase.
 * - HS256 (Supabase local / proyectos legacy): secreto compartido.
 */
export function createSupabaseVerifier(opts: { supabaseUrl: string; jwtSecret?: string }): TokenVerifier {
  const issuer = `${opts.supabaseUrl.replace(/\/$/, '')}/auth/v1`;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  const secret = opts.jwtSecret ? new TextEncoder().encode(opts.jwtSecret) : undefined;
  const common = { issuer, audience: 'authenticated' };

  return {
    async verify(token) {
      let payload: JWTPayload;
      try {
        const { alg } = decodeProtectedHeader(token);
        if (alg === 'HS256') {
          if (!secret) throw new Error('HS256 no habilitado');
          ({ payload } = await jwtVerify(token, secret, { ...common, algorithms: ['HS256'] }));
        } else {
          ({ payload } = await jwtVerify(token, jwks, { ...common, algorithms: ['ES256', 'RS256'] }));
        }
      } catch {
        throw new HttpError(401, 'invalid_token', 'Sesión inválida o expirada');
      }
      if (typeof payload.sub !== 'string' || payload.role !== 'authenticated')
        throw new HttpError(401, 'invalid_token', 'Sesión inválida o expirada');
      return {
        userId: payload.sub,
        email: typeof payload.email === 'string' ? payload.email : undefined,
        aal: payload.aal === 'aal2' ? 'aal2' : 'aal1',
      };
    },
  };
}
