import type { Actor } from '@aiment/core';
import type { Db } from '@aiment/db';
import type { AuthAdmin } from '@aiment/business';
import type { Mailer } from '@aiment/mail';
import type { ObjectStorage } from '@aiment/storage';
import type { DeviceContext, ShiftContext } from '@aiment/staff';
import type { AuthClaims, TokenVerifier } from './auth/verifier';
import type { RateLimiter, RateLimits } from './rate-limit';

export interface AppConfig {
  requireSuperadminMfa: boolean;
  /** Base pública configurada: se usa en enlaces que salen del sistema (correos, QR impresos). */
  publicBaseUrl?: string;
  /** true detrás de un proxy/túnel de confianza: la IP del cliente sale de X-Forwarded-For. */
  trustProxy?: boolean;
  rateLimits?: Partial<RateLimits>;
  /** Sal para el hash diario de visitantes (no se guarda la IP). */
  visitorSalt?: string;
  /**
   * Cookies de caja con atributo Secure. Por defecto: true si PUBLIC_BASE_URL es https
   * (túnel, staging, producción); false en http://localhost.
   */
  secureCookies?: boolean;
}

export interface AppDeps {
  db: Db;
  verifier: TokenVerifier;
  config: AppConfig;
  mailer?: Mailer;
  /** Logos y archivos del negocio. Por defecto, en memoria (tests). */
  storage?: ObjectStorage;
  /** Invitaciones de dueños (Supabase Auth admin). null = no configurado (sin SUPABASE_SECRET_KEY). */
  authAdmin?: AuthAdmin | null;
}

/** Dependencias ya resueltas con valores por defecto (las usan las rutas). */
export interface ResolvedDeps extends AppDeps {
  mailer: Mailer;
  storage: ObjectStorage;
  authAdmin: AuthAdmin | null;
  publicBaseUrl: string;
  limiter: RateLimiter;
}

export interface AppUser {
  id: string;
  email: string;
  fullName: string | null;
  isSuperadmin: boolean;
}

export type AppEnv = {
  Variables: {
    deps: ResolvedDeps;
    claims: AuthClaims;
    user: AppUser;
    actor: Actor;
    orgId: string;
    device: DeviceContext;
    shift: ShiftContext;
  };
};
