import type { Actor } from '@aiment/core';
import type { Db } from '@aiment/db';
import type { AuthClaims, TokenVerifier } from './auth/verifier';

export interface AppDeps {
  db: Db;
  verifier: TokenVerifier;
  config: { requireSuperadminMfa: boolean };
}

export interface AppUser {
  id: string;
  email: string;
  fullName: string | null;
  isSuperadmin: boolean;
}

export type AppEnv = {
  Variables: {
    deps: AppDeps;
    claims: AuthClaims;
    user: AppUser;
    actor: Actor;
    orgId: string;
  };
};
