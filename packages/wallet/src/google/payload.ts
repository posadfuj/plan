/**
 * Contenido de los pases de fidelización de Google Wallet: una clase por programa (marca del
 * negocio) y un objeto por membresía (saldo, QR de caja). Funciones puras: las usan el enlace
 * "Guardar en Google Wallet", la API de Google y la vista previa del modo simulado.
 */
import { createHash } from 'node:crypto';
import type { MembershipView, ProgramView } from '../types';

/** Color de fondo si el negocio no eligió uno (gris oscuro, contraste alto con texto blanco). */
const DEFAULT_BACKGROUND = '#1F2937';

/** Google solo admite [A-Za-z0-9._-] después del "<issuerId>.". */
export const safeIdSuffix = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');

/**
 * Id de la clase de un programa: estable y opaco (no expone el id interno del programa).
 * Cambia con la cuenta emisora: al migrar de cuenta, cada una tiene sus propias clases.
 */
export function googleClassId(issuerId: string, programId: string): string {
  const h = createHash('sha256').update(`${issuerId}:${programId}`).digest('hex').slice(0, 24);
  return `${issuerId}.aw_c_${h}`;
}

const text = (value: string) => ({ defaultValue: { language: 'es-PE', value } });

export interface LoyaltyClassInput {
  classId: string;
  view: Pick<ProgramView, 'organizationName' | 'programName' | 'primaryColor'>;
  /** URL pública https del logo (Google la descarga al guardar el pase). */
  logoUrl: string;
  /** Enlace "Powered by Aiment Wallet" en el detalle del pase (opcional hasta tener dominio). */
  poweredByUrl?: string;
}

export function buildLoyaltyClass({ classId, view, logoUrl, poweredByUrl }: LoyaltyClassInput) {
  return {
    id: classId,
    issuerName: view.organizationName,
    programName: view.programName,
    programLogo: {
      sourceUri: { uri: logoUrl },
      contentDescription: text(`Logo de ${view.organizationName}`),
    },
    hexBackgroundColor: view.primaryColor ?? DEFAULT_BACKGROUND,
    countryCode: 'PE',
    reviewStatus: 'UNDER_REVIEW',
    ...(poweredByUrl
      ? {
          linksModuleData: {
            uris: [{ uri: poweredByUrl, description: 'Powered by Aiment Wallet', id: 'powered_by' }],
          },
        }
      : {}),
  };
}
export type LoyaltyClass = ReturnType<typeof buildLoyaltyClass>;

/**
 * Lo que cambia cuando el dueño edita la marca o el programa. Google lo propaga a todos los
 * pases guardados de esa clase. `reviewStatus` es obligatorio al editar una clase.
 */
export function buildClassPatch(input: LoyaltyClassInput) {
  const { issuerName, programName, programLogo, hexBackgroundColor, reviewStatus } = buildLoyaltyClass(input);
  return { issuerName, programName, programLogo, hexBackgroundColor, reviewStatus };
}

/** "7 de 10 sellos · te faltan 3" / "120 puntos". */
export function progressText(view: MembershipView): string {
  if (view.mode === 'stamps' && view.goal) {
    const left = Math.max(0, view.goal - view.balance);
    const base = `${view.balance} de ${view.goal} ${view.unitLabel}`;
    return left > 0 ? `${base} · te ${left === 1 ? 'falta' : 'faltan'} ${left}` : `${base} · ¡meta cumplida!`;
  }
  return `${view.balance} ${view.unitLabel}`;
}

export function buildLoyaltyObject(objectId: string, classId: string, view: MembershipView) {
  const blocked = view.status === 'blocked';
  const label =
    view.mode === 'stamps' && view.goal ? `${view.unitLabel} (meta ${view.goal})` : view.unitLabel;
  return {
    id: objectId,
    classId,
    state: 'ACTIVE',
    accountId: view.shortCode,
    accountName: view.customerDisplayName,
    loyaltyPoints: { label, balance: { int: view.balance } },
    secondaryLoyaltyPoints: { label: 'Premios por canjear', balance: { int: view.availableRewards } },
    // Tarjeta pausada por el negocio: sin QR, igual que la tarjeta web (no se puede operar en caja).
    // Se reemplaza por un texto (no se omite): una actualización parcial dejaría el QR anterior.
    barcode: blocked
      ? { type: 'TEXT_ONLY', value: 'Tarjeta pausada' }
      : { type: 'QR_CODE', value: view.scanUrl, alternateText: view.shortCode },
    textModulesData: [
      blocked
        ? {
            id: 'status',
            header: 'Tarjeta pausada',
            body: `${view.organizationName} pausó tu tarjeta. Consulta en el local: tus ${view.unitLabel} siguen guardados.`,
          }
        : { id: 'progress', header: 'Tu progreso', body: progressText(view) },
      // El mismo mensaje automático que la tarjeta web (bienvenida, meta cumplida, te falta poco).
      ...(!blocked && view.message
        ? [{ id: 'message', header: view.organizationName, body: view.message }]
        : []),
      { id: 'powered_by', header: 'Tarjeta digital', body: 'Powered by Aiment Wallet' },
    ],
  };
}
export type LoyaltyObject = ReturnType<typeof buildLoyaltyObject>;

/**
 * Cliente eliminado (derecho de supresión): el pase queda inactivo, sin nombre y sin QR (el token
 * de caja ya se rotó al eliminarlo, pero tampoco se deja a la vista).
 */
export function buildRevokedPatch() {
  return {
    state: 'INACTIVE',
    accountName: 'Tarjeta cerrada',
    barcode: { type: 'TEXT_ONLY', value: 'Tarjeta cerrada' },
    textModulesData: [
      {
        id: 'status',
        header: 'Tarjeta cerrada',
        body: 'Esta tarjeta ya no está activa. Puedes eliminarla de tu Google Wallet.',
      },
    ],
  };
}
