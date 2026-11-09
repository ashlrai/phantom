import { statfsSync } from 'node:fs';
import { homedir, platform, totalmem } from 'node:os';
import { assessHostHeadroom, readMacHostHeadroom, type HostHeadroom } from '../../run/host-headroom.js';

const GIB = 1024 ** 3;
export interface NodeCapacity {
  slots: number;
  ramBytes: number;
  held: 'memory-unmeasured' | 'memory-pressure' | 'disk-unmeasured' | 'disk-pressure' | null;
}

/** Conservative CLI-job budgets, not a promise that a local model fits in memory. */
export function nodeRamSlots(bytes: number): number {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return 0;
  return Math.max(0, Math.min(64, Math.floor((bytes - Math.max(4 * GIB, bytes * 0.3)) / (4 * GIB))));
}

export function assessNodeCapacity(ramBytes: number, memory: HostHeadroom | null, freeDiskBytes: number | null): NodeCapacity {
  let held: NodeCapacity['held'] = null;
  const headroom = assessHostHeadroom(memory);
  if (!headroom.reading) held = 'memory-unmeasured';
  else if (!nodeRamSlots(ramBytes) || !headroom.allowed) held = 'memory-pressure';
  else if (freeDiskBytes === null || !Number.isFinite(freeDiskBytes) || freeDiskBytes < 0) held = 'disk-unmeasured';
  else if (freeDiskBytes < 20_000_000_000) held = 'disk-pressure';
  return { ramBytes, slots: held ? 0 : nodeRamSlots(ramBytes), held };
}

/** Additive to DISKGUARD: never substitutes for the runner's existing disk checks. */
export function readNodeCapacity(): NodeCapacity {
  let freeDisk: number | null = null;
  try { const disk = statfsSync(homedir()); freeDisk = disk.bavail * disk.bsize; } catch { /* unknown holds */ }
  return assessNodeCapacity(totalmem(), platform() === 'darwin' ? readMacHostHeadroom() : null, freeDisk);
}
