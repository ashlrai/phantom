import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface FleetMemoryPaths {
  pausePath?: string;
  metricsPath?: string;
  admissionPath?: string;
}

/** Local observations only. Null means unavailable, never zero or permission to launch. */
export interface FleetMemoryStatus {
  pause: { state: 'present' | 'absent' | 'unknown'; reason: string | null };
  freeMemoryPercent: number | null;
  swapUsedBytes: number | null;
  admissionWaitsByPool: Record<string, number> | null;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/** No probes, subprocesses, network calls, or writes. Each source fails independently. */
export async function readFleetMemory(paths: FleetMemoryPaths = {}): Promise<FleetMemoryStatus> {
  const root = join(homedir(), '.ashlr-runs');
  const pauseRead = async (): Promise<FleetMemoryStatus['pause']> => {
    try {
      const reason = (await readFile(paths.pausePath ?? join(root, 'PAUSE'), 'utf8')).trim();
      return { state: 'present', reason: reason || null };
    } catch (error) {
      return {
        state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unknown',
        reason: null,
      };
    }
  };
  const [pause, metrics, admission] = await Promise.all([
    pauseRead(),
    readJson(paths.metricsPath ?? join(root, 'memguard.json')),
    readJson(paths.admissionPath ?? join(root, 'admission-waits.json')),
  ]);
  const free = record(metrics) ? metrics.freeMemoryPercent : null;
  const swap = record(metrics) ? metrics.swapUsedBytes : null;
  const waits = record(admission) ? admission.admissionWaitsByPool : null;
  return {
    pause,
    freeMemoryPercent: nonnegative(free) && free <= 100 ? free : null,
    swapUsedBytes: nonnegative(swap) ? swap : null,
    admissionWaitsByPool: record(waits) && Object.values(waits).every(
      (count) => nonnegative(count) && Number.isSafeInteger(count),
    ) ? Object.fromEntries(Object.entries(waits)) as Record<string, number> : null,
  };
}
