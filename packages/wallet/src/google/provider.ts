/**
 * Proveedor de Google Wallet. El mismo código corre en modo simulado (API en memoria y clave
 * generada al arrancar) y en modo real (API de Google con la cuenta de servicio del emisor):
 * pasar de uno a otro es configuración (ver config.ts).
 */
import { randomBytes } from 'node:crypto';
import type {
  IssueResult,
  MembershipView,
  ProgramView,
  WalletNotice,
  WalletPassRef,
  WalletProvider,
} from '../types';
import { isConflict, isNotFound, type GoogleWalletApi } from './api';
import {
  buildClassPatch,
  buildLoyaltyClass,
  buildLoyaltyObject,
  buildRevokedPatch,
  googleClassId,
  safeIdSuffix,
} from './payload';
import { GOOGLE_SAVE_URL, signSaveJwt, type GoogleServiceAccount } from './save-link';

export type GoogleWalletMode = 'live' | 'simulated';

/** Página de la PWA que muestra el pase simulado (el JWT viaja en el fragmento: no llega a ningún servidor). */
export const SIMULATED_SAVE_PATH = '/wallet/google-simulado';
/** Logo por defecto (PNG en la PWA) si el negocio no subió uno o lo subió en un formato que Google no acepta. */
export const DEFAULT_LOGO_PATH = '/wallet-logo.png';

export interface GoogleWalletProviderOptions {
  mode: GoogleWalletMode;
  issuerId: string;
  serviceAccount: GoogleServiceAccount;
  api: GoogleWalletApi;
  /** Origen público de la PWA: logo por defecto, página simulada y `origins` del JWT. */
  publicBaseUrl: string;
}

export class GoogleWalletProvider implements WalletProvider {
  readonly name = 'google' as const;
  readonly issuerRef: string;
  private readonly base: string;

  constructor(private readonly opts: GoogleWalletProviderOptions) {
    this.issuerRef = `${opts.mode === 'live' ? 'google' : 'google-sim'}:${opts.issuerId}`;
    this.base = opts.publicBaseUrl.replace(/\/$/, '');
  }

  get mode(): GoogleWalletMode {
    return this.opts.mode;
  }

  handles(issuerRef: string): boolean {
    return issuerRef === this.issuerRef;
  }

  /**
   * Enlace "Guardar en Google Wallet" con la clase y el objeto completos: no llama a la API de
   * Google, así el botón funciona aunque la API esté caída.
   */
  async issue(view: MembershipView, existing?: string): Promise<IssueResult> {
    const objectId = existing ?? `${this.opts.issuerId}.aw_${randomBytes(12).toString('hex')}`;
    const { loyaltyClass, loyaltyObject } = this.payload(view, objectId);
    const jwt = await signSaveJwt({
      serviceAccount: this.opts.serviceAccount,
      loyaltyClass,
      loyaltyObject,
      origins: [new URL(this.base).origin],
    });
    const addUrl =
      this.opts.mode === 'live' ? `${GOOGLE_SAVE_URL}${jwt}` : `${this.base}${SIMULATED_SAVE_PATH}#${jwt}`;
    return { externalId: objectId, issuerRef: this.issuerRef, addUrl };
  }

  /**
   * Envía el estado actual. Si el objeto no existe (el cliente abrió el enlace pero aún no tocó
   * "Guardar"), se crea con el estado actual: al guardarlo después, verá el saldo correcto.
   */
  async update(view: MembershipView, pass: WalletPassRef): Promise<void> {
    const { loyaltyClass, loyaltyObject } = this.payload(view, pass.externalId);
    try {
      await this.opts.api.patchObject(pass.externalId, loyaltyObject);
      return;
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    try {
      await this.opts.api.insertClass(loyaltyClass);
    } catch (err) {
      if (!isConflict(err)) throw err;
    }
    try {
      await this.opts.api.insertObject(loyaltyObject);
    } catch (err) {
      // Lo guardó justo ahora desde el enlace: se actualiza encima.
      if (!isConflict(err)) throw err;
      await this.opts.api.patchObject(pass.externalId, loyaltyObject);
    }
  }

  async revoke(pass: WalletPassRef): Promise<void> {
    try {
      await this.opts.api.patchObject(pass.externalId, buildRevokedPatch());
    } catch (err) {
      if (!isNotFound(err)) throw err; // nunca lo guardó: no hay nada que cerrar en Google
    }
  }

  /**
   * El dueño cambió nombre, color, logo o programa: se actualiza la clase y Google lo muestra en
   * todos los pases guardados. Si nadie guardó aún un pase, la clase no existe: se creará con la
   * marca nueva en el próximo pase.
   */
  async updateProgram(program: ProgramView): Promise<void> {
    const classId = googleClassId(this.opts.issuerId, program.programId);
    try {
      await this.opts.api.patchClass(
        classId,
        buildClassPatch({ classId, view: program, logoUrl: this.logo(program) }),
      );
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  /** Notificación en el celular (máx. 3 por pase cada 24 h según Google). Repetirla no duplica. */
  async notify(_view: MembershipView, pass: WalletPassRef, notice: WalletNotice): Promise<void> {
    try {
      await this.opts.api.addMessage(pass.externalId, {
        id: safeIdSuffix(notice.id),
        header: notice.header,
        body: notice.body,
        messageType: 'TEXT_AND_NOTIFY',
      });
    } catch (err) {
      // 409: ya se envió · 404: el cliente no guardó el pase (no hay a quién avisar).
      if (!isConflict(err) && !isNotFound(err)) throw err;
    }
  }

  private logo(v: Pick<ProgramView, 'logoUrl'>) {
    return v.logoUrl ?? `${this.base}${DEFAULT_LOGO_PATH}`;
  }

  private payload(view: MembershipView, objectId: string) {
    const classId = googleClassId(this.opts.issuerId, view.programId);
    return {
      loyaltyClass: buildLoyaltyClass({
        classId,
        view,
        logoUrl: this.logo(view),
      }),
      loyaltyObject: buildLoyaltyObject(objectId, classId, view),
    };
  }
}
