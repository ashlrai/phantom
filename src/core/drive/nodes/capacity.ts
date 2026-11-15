import { statfsSync } from 'node:fs';
import { homedir, platform, totalmem } from 'node:os';
import { assessHostHeadroom, readMacHostHeadroom, type HostHeadroom } from '../../run/host-headroom.js';

const GIB = 1024 ** 3;
export interface NodeCapacity {
  slots: number;
  ramBytes: number;
  held: 'memory-unmeasured' | 'memory-pressure' | 'disk-unmeasured' | 'disk-pressure' | null;
}

const MIB = 1024 ** 2;

/**
 * Per-slot RAM budget by job pack. Only this divisor is pack-aware: the host reserve
 * (max(4 GiB, 30%)), the 64-slot cap, pressure and disk guards apply to every pack.
 * Unknown packs (including future local-model packs, whose footprint belongs to the
 * model planner in local-runtime/omlx) keep the conservative 4 GiB budget.
 */
export const PACK_RAM_BYTES: Readonly<Record<string, number>> = {
  'codex-file': GIB, // `codex exec`: thin CLI around API calls, ~0.5-1 GiB real
  'shell-check': 384 * MIB, // pure local probes
  'omlx-ping': 384 * MIB,
};
export const DEFAULT_PACK_RAM_BYTES = 4 * GIB;
/** Slots are advertised before a job is pulled, so they use the dominant workload: API-bound CLI jobs. */
export const ADVERTISED_PACK = 'codex-file';

export function packRamBytes(pack: string = ADVERTISED_PACK): number {
  return Object.hasOwn(PACK_RAM_BYTES, pack) ? PACK_RAM_BYTES[pack]! : DEFAULT_PACK_RAM_BYTES;
}

export function nodeRamSlots(bytes: number, pack: string = ADVERTISED_PACK): number {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return 0;
  return Math.max(0, Math.min(64, Math.floor((bytes - Math.max(4 * GIB, bytes * 0.3)) / packRamBytes(pack))));
}

export function assessNodeCapacity(ramBytes: number, memory: HostHeadroom | null, freeDiskBytes: number | null, light = false): NodeCapacity {
  let held: NodeCapacity['held'] = null;
  const headroom = assessHostHeadroom(memory);
  if (!headroom.reading) held = 'memory-unmeasured';
  else if (!nodeRamSlots(ramBytes) || !headroom.allowed) held = 'memory-pressure';
  else if (freeDiskBytes === null || !Number.isFinite(freeDiskBytes) || freeDiskBytes < 0) held = 'disk-unmeasured';
  else if (freeDiskBytes < 20_000_000_000) held = 'disk-pressure';
  // Only the fixed light recipe runner uses this profile; all pressure/disk floors still apply.
  return { ramBytes, slots: held ? 0 : light ? Math.min(2, nodeRamSlots(ramBytes) * 2) : nodeRamSlots(ramBytes), held };
}

/** Additive to DISKGUARD: never substitutes for the runner's existing disk checks. */
export function readNodeCapacity(light = false): NodeCapacity {
  let freeDisk: number | null = null;
  try { const disk = statfsSync(homedir()); freeDisk = disk.bavail * disk.bsize; } catch { /* unknown holds */ }
  return assessNodeCapacity(totalmem(), platform() === 'darwin' ? readMacHostHeadroom() : null, freeDisk, light);
}
