/**
 * Google Wallet simulado: imita las respuestas de la API real (404, 409, caídas) en memoria.
 * El proveedor de Google corre su código completo contra esto; solo cambia el cliente HTTP.
 */
import { GoogleApiError, type GoogleWalletApi } from './api';
import type { LoyaltyClass, LoyaltyObject } from './payload';

export interface SimulatedGoogleCall {
  op: 'insertClass' | 'insertObject' | 'patchObject';
  id: string;
  at: Date;
}

export class SimulatedGoogleWalletApi implements GoogleWalletApi {
  readonly classes = new Map<string, LoyaltyClass>();
  readonly objects = new Map<string, Record<string, unknown>>();
  readonly calls: SimulatedGoogleCall[] = [];
  private failures: number[] = [];
  /** true = Google caído: toda llamada falla con 503 hasta volver a false. */
  down = false;

  constructor(private readonly opts: { log?: (msg: string) => void } = {}) {}

  /** Las próximas `n` llamadas fallan con `status` (503 por defecto: reintentable). */
  failNext(n: number, status = 503): void {
    this.failures.push(...Array<number>(n).fill(status));
  }

  /** Lo que pasa cuando el cliente toca "Guardar" en su Android: Google crea lo que falte. */
  saveFromJwt(payload: { loyaltyClasses?: LoyaltyClass[]; loyaltyObjects?: LoyaltyObject[] }): void {
    for (const c of payload.loyaltyClasses ?? []) if (!this.classes.has(c.id)) this.classes.set(c.id, c);
    for (const o of payload.loyaltyObjects ?? []) if (!this.objects.has(o.id)) this.objects.set(o.id, o);
  }

  async insertClass(c: LoyaltyClass) {
    this.check('insertClass', c.id);
    if (this.classes.has(c.id)) throw new GoogleApiError(409, `clase ${c.id} ya existe`);
    this.classes.set(c.id, c);
  }

  async insertObject(o: LoyaltyObject) {
    this.check('insertObject', o.id);
    if (this.objects.has(o.id)) throw new GoogleApiError(409, `objeto ${o.id} ya existe`);
    if (!this.classes.has(o.classId)) throw new GoogleApiError(404, `clase ${o.classId} no existe`);
    this.objects.set(o.id, o);
    this.opts.log?.(`[google simulado] objeto creado ${o.id}: ${o.loyaltyPoints.balance.int}`);
  }

  async patchObject(id: string, o: Record<string, unknown>) {
    this.check('patchObject', id);
    const cur = this.objects.get(id);
    if (!cur) throw new GoogleApiError(404, `objeto ${id} no existe`);
    // Como la API real: los campos enviados se reemplazan enteros; los demás quedan igual.
    const next = { ...cur, ...o };
    this.objects.set(id, next);
    const points = (next.loyaltyPoints as LoyaltyObject['loyaltyPoints'] | undefined)?.balance.int;
    this.opts.log?.(
      `[google simulado] objeto actualizado ${id}: ${String(next.state)} · saldo ${points ?? '—'}`,
    );
  }

  private check(op: SimulatedGoogleCall['op'], id: string) {
    this.calls.push({ op, id, at: new Date() });
    if (this.down) throw new GoogleApiError(503, 'Google Wallet simulado: servicio no disponible');
    const status = this.failures.shift();
    if (status) throw new GoogleApiError(status, `Google Wallet simulado: fallo ${status}`);
  }
}
