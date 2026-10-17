/**
 * Recursos del servidor vistos desde el contenedor: RAM y carga del host (Docker no los aísla en
 * /proc) y el disco donde vive Docker.
 */
import { readFile, statfs } from 'node:fs/promises';
import { cpus, freemem, loadavg, totalmem } from 'node:os';

export interface HostStats {
  memUsedPct: number;
  /** Carga promedio de 5 minutos dividida por núcleos (1 = todos los núcleos ocupados). */
  loadPerCore: number;
  diskUsedPct: number | null;
}

/** RAM usada real: Linux cuenta la caché como "libre para usar" (MemAvailable); freemem() no. */
async function memUsedPct(): Promise<number> {
  try {
    const info = await readFile('/proc/meminfo', 'utf8');
    const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(info)?.[1]);
    const total = kb('MemTotal');
    const available = kb('MemAvailable');
    if (total && available) return Math.round((1 - available / total) * 1000) / 10;
  } catch {
    // macOS y otros: sin /proc
  }
  return Math.round((1 - freemem() / totalmem()) * 1000) / 10;
}

export async function hostStats(diskPath = '/'): Promise<HostStats> {
  let diskUsedPct: number | null;
  try {
    const s = await statfs(diskPath);
    diskUsedPct = Math.round((1 - s.bavail / s.blocks) * 1000) / 10;
  } catch {
    diskUsedPct = null;
  }
  return {
    memUsedPct: await memUsedPct(),
    loadPerCore: Math.round((loadavg()[1]! / Math.max(1, cpus().length)) * 100) / 100,
    diskUsedPct,
  };
}
