/** Arranque de API + PWA para la demo y el túnel (si no están corriendo ya). */
import { spawn, type ChildProcess } from 'node:child_process';
import { repoRoot } from '@aiment/config';

export async function isUp(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function waitUp(url: string, seconds = 60): Promise<void> {
  for (let i = 0; i < seconds; i++) {
    if (await isUp(url)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`No respondió ${url}`);
}

const shell = process.platform === 'win32';

/** Levanta API y PWA en segundo plano. Devuelve una función para detenerlos. */
export function startServices(env: Record<string, string> = {}): () => void {
  const opts = { cwd: repoRoot, env: { ...process.env, ...env }, stdio: 'ignore' as const, shell };
  const children: ChildProcess[] = [
    spawn('pnpm', ['--filter', '@aiment/api', 'start'], opts),
    spawn('pnpm', ['--filter', '@aiment/web', 'dev'], opts),
  ];
  return () => children.forEach((c) => c.kill());
}
