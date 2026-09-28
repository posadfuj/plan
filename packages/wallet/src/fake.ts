import type { IssueResult, MembershipView, WalletPassRef, WalletProvider, WalletProviderName } from './types';
import { WalletProviderError } from './types';

export interface FakeWalletCall {
  op: 'issue' | 'update' | 'revoke';
  provider: WalletProviderName;
  membershipId?: string;
  externalId?: string;
  balance?: number;
  at: Date;
}

/**
 * Wallet simulado para desarrollo local y tests: no llama a Apple ni a Google.
 * Registra lo que "habría enviado" y puede simular fallos para probar reintentos.
 */
export class FakeWalletProvider implements WalletProvider {
  readonly issuerRef: string;
  readonly calls: FakeWalletCall[] = [];
  private failuresLeft = 0;

  constructor(
    readonly name: WalletProviderName,
    private readonly opts: { log?: (msg: string) => void } = {},
  ) {
    this.issuerRef = `fake:${name}-local`;
  }

  /** Hace fallar las próximas `n` operaciones (error reintentable). */
  failNext(n: number): void {
    this.failuresLeft = n;
  }

  handles(issuerRef: string): boolean {
    return issuerRef.startsWith(`fake:${this.name}`);
  }

  private maybeFail(op: string) {
    if (this.failuresLeft > 0) {
      this.failuresLeft--;
      throw new WalletProviderError(`[fake ${this.name}] fallo simulado en ${op}`);
    }
  }

  async issue(view: MembershipView): Promise<IssueResult> {
    this.maybeFail('issue');
    const externalId = this.name === 'google' ? `fake.${view.membershipId}` : `fake-${view.membershipId}`;
    this.record({ op: 'issue', membershipId: view.membershipId, externalId, balance: view.balance });
    return { externalId, issuerRef: this.issuerRef, addUrl: `fake://${this.name}/add/${externalId}` };
  }

  async update(view: MembershipView, pass: WalletPassRef): Promise<void> {
    this.maybeFail('update');
    this.record({
      op: 'update',
      membershipId: view.membershipId,
      externalId: pass.externalId,
      balance: view.balance,
    });
    this.opts.log?.(
      `[wallet simulado · ${this.name}] pase ${pass.externalId} → ${view.organizationName}: ${view.balance} ${view.unitLabel}` +
        (view.goal ? ` de ${view.goal}` : '') +
        (view.availableRewards ? ` · ${view.availableRewards} premio(s) disponible(s)` : ''),
    );
  }

  async revoke(pass: WalletPassRef): Promise<void> {
    this.maybeFail('revoke');
    this.record({ op: 'revoke', externalId: pass.externalId });
  }

  private record(c: Omit<FakeWalletCall, 'provider' | 'at'>) {
    this.calls.push({ ...c, provider: this.name, at: new Date() });
  }
}
