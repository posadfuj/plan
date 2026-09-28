/**
 * Contrato común de los proveedores de Wallet. El motor de fidelización nunca depende
 * de Apple o Google directamente: solo de esta interfaz.
 */
export type WalletProviderName = 'apple' | 'google';

/** Proyección de solo lectura de una membresía: lo que se muestra en el pase. */
export interface MembershipView {
  membershipId: string;
  organizationId: string;
  organizationName: string;
  programName: string;
  mode: 'stamps' | 'points';
  unitLabel: string;
  balance: number;
  /** Meta en modo sellos (p. ej. 10). */
  goal: number | null;
  availableRewards: number;
  customerDisplayName: string;
  /** Contenido del QR que escanea la caja: URL /s/{member_scan_token}. */
  scanUrl: string;
  shortCode: string;
  primaryColor: string | null;
}

export interface WalletPassRef {
  walletPassId: string;
  provider: WalletProviderName;
  /** Cuenta/equipo emisor con que se emitió el pase. */
  issuerRef: string;
  externalId: string;
}

export interface IssueResult {
  externalId: string;
  issuerRef: string;
  /** Apple: URL de descarga del .pkpass · Google: URL "Guardar en Google Wallet". */
  addUrl: string;
}

export interface WalletProvider {
  readonly name: WalletProviderName;
  /** Cuenta emisora activa (desde configuración). Los pases nuevos se emiten con ella. */
  readonly issuerRef: string;
  /** ¿Puede actualizar pases emitidos con esta cuenta? Permite convivir cuentas durante una migración. */
  handles(issuerRef: string): boolean;
  issue(view: MembershipView): Promise<IssueResult>;
  update(view: MembershipView, pass: WalletPassRef): Promise<void>;
  revoke(pass: WalletPassRef): Promise<void>;
}

export class WalletProviderError extends Error {
  constructor(
    message: string,
    /** false = no tiene sentido reintentar (p. ej. credenciales inválidas). */
    readonly retryable = true,
  ) {
    super(message);
  }
}
