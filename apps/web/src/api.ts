/** Cliente mínimo de la API (mismo origen). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  init: RequestInit & { json?: unknown; token?: string } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.json !== undefined) headers.set('content-type', 'application/json');
  if (init.token) headers.set('authorization', `Bearer ${init.token}`);
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    });
  } catch {
    throw new ApiError(0, 'network', 'Sin conexión. Revisa tu internet y vuelve a intentar.');
  }
  const data = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
  if (!res.ok)
    throw new ApiError(
      res.status,
      data?.error?.code ?? 'error',
      data?.error?.message ?? 'Ocurrió un error. Intenta de nuevo.',
    );
  return data as T;
}

// --- Tipos de las respuestas públicas ----------------------------------------
export interface Branding {
  primaryColor: string;
  logoUrl: string | null;
  poweredBy: boolean;
}
export interface JoinInfo {
  organization: { id: string; name: string; branding: Branding };
  branch: string | null;
  program: {
    name: string;
    mode: 'stamps' | 'points';
    unitLabel: string;
    goal: number | null;
    rewards: { name: string; kind: string; cost: number | null }[];
  };
  consents: {
    terms: { version: number; body: string } | null;
    privacy: { version: number; body: string } | null;
    marketing: { version: number; body: string } | null;
  };
}
export type RegisterResult =
  { status: 'created'; webCardToken: string } | { status: 'already_registered'; message: string };
export interface Card {
  organization: { id: string; name: string; branding: Branding };
  program: { name: string; mode: 'stamps' | 'points'; unitLabel: string; goal: number | null };
  customer: { name: string; memberSince: string };
  balance: number;
  progress: { current: number; target: number } | null;
  nextReward: { name: string; remaining: number } | null;
  redeemable: string[];
  scanPath: string;
  shortCode: string;
  history: { kind: string; delta: number; balanceAfter: number; at: string }[];
  wallet: { apple: { available: boolean }; google: { available: boolean } };
}
