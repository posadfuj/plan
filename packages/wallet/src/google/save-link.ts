import { importPKCS8, SignJWT } from 'jose';
import type { MembershipView } from '../types';

/** Campos mínimos del JSON de una cuenta de servicio de Google Cloud. */
export interface GoogleServiceAccount {
  client_email: string;
  private_key: string;
}

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
  /** Orígenes web desde donde se mostrará el botón (opcional). */
  origins?: string[];
  /** Enlace "Powered by Aiment Wallet" en el detalle del pase (opcional hasta tener dominio). */
  poweredByUrl?: string;
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');

/** Construye la clase (programa) y el objeto (membresía) de fidelización de Google Wallet. */
export function buildLoyaltyPayload(input: Omit<GoogleSaveLinkInput, 'serviceAccount' | 'origins'>) {
  const { issuerId, view } = input;
  const classId = `${issuerId}.${safe(input.classSuffix)}`;
  const objectId = `${issuerId}.${safe(input.objectSuffix)}`;
  const balanceLabel =
    view.mode === 'stamps' && view.goal ? `${view.unitLabel} (meta ${view.goal})` : view.unitLabel;

  const loyaltyClass = {
    id: classId,
    issuerName: view.organizationName,
    programName: view.programName,
    programLogo: {
      sourceUri: { uri: input.logoUrl },
      contentDescription: { defaultValue: { language: 'es-PE', value: `Logo de ${view.organizationName}` } },
    },
    hexBackgroundColor: view.primaryColor ?? '#1F2937',
    reviewStatus: 'UNDER_REVIEW',
    ...(input.poweredByUrl
      ? {
          linksModuleData: {
            uris: [{ uri: input.poweredByUrl, description: 'Powered by Aiment Wallet', id: 'powered_by' }],
          },
        }
      : {}),
  };

  const loyaltyObject = {
    id: objectId,
    classId,
    state: 'ACTIVE',
    accountId: view.shortCode,
    accountName: view.customerDisplayName,
    loyaltyPoints: { label: balanceLabel, balance: { int: view.balance } },
    barcode: { type: 'QR_CODE', value: view.scanUrl, alternateText: view.shortCode },
    textModulesData: [
      {
        id: 'next_reward',
        header: 'Tu progreso',
        body:
          view.mode === 'stamps' && view.goal
            ? `${view.balance} de ${view.goal} ${view.unitLabel}`
            : `${view.balance} ${view.unitLabel}`,
      },
      { id: 'powered_by', header: 'Tarjeta digital', body: 'Powered by Aiment Wallet' },
    ],
  };

  return { classId, objectId, loyaltyClass, loyaltyObject };
}

/**
 * Enlace "Guardar en Google Wallet": un JWT firmado (RS256) con la cuenta de servicio del emisor.
 * La clase y el objeto viajan dentro del JWT; Google los crea al guardar.
 */
export async function buildGoogleSaveUrl(input: GoogleSaveLinkInput) {
  const { classId, objectId, loyaltyClass, loyaltyObject } = buildLoyaltyPayload(input);
  const key = await importPKCS8(input.serviceAccount.private_key, 'RS256');
  const jwt = await new SignJWT({
    typ: 'savetowallet',
    origins: input.origins ?? [],
    payload: { loyaltyClasses: [loyaltyClass], loyaltyObjects: [loyaltyObject] },
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(input.serviceAccount.client_email)
    .setAudience('google')
    .setIssuedAt()
    .sign(key);
  return { url: `https://pay.google.com/gp/v/save/${jwt}`, jwt, classId, objectId };
}
