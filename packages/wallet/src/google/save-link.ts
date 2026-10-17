import { importPKCS8, SignJWT } from 'jose';
import type { MembershipView } from '../types';
import {
  buildLoyaltyClass,
  buildLoyaltyObject,
  safeIdSuffix,
  type LoyaltyClass,
  type LoyaltyObject,
} from './payload';

/** Campos mínimos del JSON de una cuenta de servicio de Google Cloud. */
export interface GoogleServiceAccount {
  client_email: string;
  private_key: string;
}

/**
 * JWT "savetowallet" firmado (RS256) con la cuenta de servicio del emisor. Lleva la clase y el
 * objeto completos: Google los crea al guardar si no existen, así el botón no depende de que la
 * API de Google responda en ese momento.
 */
export async function signSaveJwt(input: {
  serviceAccount: GoogleServiceAccount;
  loyaltyClass: LoyaltyClass;
  loyaltyObject: LoyaltyObject;
  /** Orígenes web desde donde se mostrará el botón. */
  origins?: string[];
}): Promise<string> {
  const key = await importPKCS8(input.serviceAccount.private_key, 'RS256');
  return new SignJWT({
    typ: 'savetowallet',
    origins: input.origins ?? [],
    payload: { loyaltyClasses: [input.loyaltyClass], loyaltyObjects: [input.loyaltyObject] },
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(input.serviceAccount.client_email)
    .setAudience('google')
    .setIssuedAt()
    .sign(key);
}

export const GOOGLE_SAVE_URL = 'https://pay.google.com/gp/v/save/';

// --- Prueba de modo demo de la semana 1 (pnpm wallet:google-demo) ---------------------------

export interface GoogleSaveLinkInput {
  issuerId: string;
  serviceAccount: GoogleServiceAccount;
  view: MembershipView;
  /** Sufijo estable de la clase (una por programa). */
  classSuffix: string;
  /** Sufijo del objeto (uno por membresía). Solo [A-Za-z0-9._-]. */
  objectSuffix: string;
  /** Logo en una URL pública HTTPS (Google la descarga). */
  logoUrl: string;
  origins?: string[];
  poweredByUrl?: string;
}

export async function buildGoogleSaveUrl(input: GoogleSaveLinkInput) {
  const classId = `${input.issuerId}.${safeIdSuffix(input.classSuffix)}`;
  const objectId = `${input.issuerId}.${safeIdSuffix(input.objectSuffix)}`;
  const jwt = await signSaveJwt({
    serviceAccount: input.serviceAccount,
    loyaltyClass: buildLoyaltyClass({
      classId,
      view: input.view,
      logoUrl: input.logoUrl,
      ...(input.poweredByUrl ? { poweredByUrl: input.poweredByUrl } : {}),
    }),
    loyaltyObject: buildLoyaltyObject(objectId, classId, input.view),
    ...(input.origins ? { origins: input.origins } : {}),
  });
  return { url: `${GOOGLE_SAVE_URL}${jwt}`, jwt, classId, objectId };
}
