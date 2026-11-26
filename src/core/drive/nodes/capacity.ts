import { statfsSync } from 'node:fs';
import { availableParallelism, cpus, freemem, homedir, loadavg, platform, totalmem, uptime } from 'node:os';
import { assessHostHeadroom, readPlatformHostHeadroom, type HostHeadroom } from '../../run/host-headroom.js';
import { hostSlots, type HostSlotLease, type HostSlots } from './host-slots.js';

import type { HostStats } from './state.js';

const GIB = 1024 ** 3;
export interface NodeCapacity {
  slots: number;
  ramBytes: number;
  held: 'memory-unmeasured' | 'memory-pressure' | 'disk-unmeasured' | 'disk-pressure' |
    'cpu-unmeasured' | 'cpu-pressure' | 'host-slots-unmeasured' | 'host-slots-exhausted' | null;
}

export type PackResourceHint = 'memory-bound' | 'cpu-bound';
export interface CapacityOptions {
  pack?: string;
  resourceHint?: PackResourceHint;
  readCpu?: () => { parallelism: number; load: number[] } | null;
  /** Injected memory-headroom reader; defaults to the platform reader (macOS
   * kernel telemetry, Linux /proc; other platforms read nothing and hold). */
  readMemory?: () => HostHeadroom | null;
  /** Injected free-disk reader in bytes; defaults to statfs of the home directory. */
  readDisk?: () => number | null;
  registry?: HostSlots;
  lease?: HostSlotLease;
}
/** API/probe packs retain memory-only admission. Local inference also needs measured CPU headroom. */
export const PACK_RESOURCE_HINTS: Readonly<Record<string, PackResourceHint>> = {
  'codex-file': 'memory-bound', 'shell-check': 'memory-bound', 'omlx-ping': 'memory-bound', 'omlx-chat': 'cpu-bound',
};

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

export function assessNodeCapacity(ramBytes: number, memory: HostHeadroom | null, freeDiskBytes: number | null, light = false, options: CapacityOptions = {}): NodeCapacity {
  let held: NodeCapacity['held'] = null;
  const headroom = assessHostHeadroom(memory);
  if (!headroom.reading) held = 'memory-unmeasured';
  else if (!nodeRamSlots(ramBytes) || !headroom.allowed) held = 'memory-pressure';
  else if (freeDiskBytes === null || !Number.isFinite(freeDiskBytes) || freeDiskBytes < 0) held = 'disk-unmeasured';
  else if (freeDiskBytes < 20_000_000_000) held = 'disk-pressure';
  const pack = options.pack ?? ADVERTISED_PACK;
  const hint = options.resourceHint ?? (Object.hasOwn(PACK_RESOURCE_HINTS, pack) ? PACK_RESOURCE_HINTS[pack] : 'memory-bound');
  if (!held && hint === 'cpu-bound') {
    let cpu = null;
    try { cpu = options.readCpu?.() ?? null; } catch { /* unknown holds */ }
    if (!cpu || !Number.isSafeInteger(cpu.parallelism) || cpu.parallelism < 1 || !Array.isArray(cpu.load) ||
        cpu.load.length !== 3 || [0, 1, 2].some(i => !Number.isFinite(cpu.load[i]) || cpu.load[i]! < 0)) held = 'cpu-unmeasured';
    else if (cpu.load[0]! + 1 > cpu.parallelism) held = 'cpu-pressure';
  }
  // Only the fixed light recipe runner uses this profile; all pressure/disk floors still apply.
  return { ramBytes, slots: held ? 0 : light ? Math.min(2, nodeRamSlots(ramBytes) * 2) : nodeRamSlots(ramBytes), held };
}

/** Additive to DISKGUARD: never substitutes for the runner's existing disk checks. */
export function readNodeCapacity(light = false, options: CapacityOptions = {}): NodeCapacity {
  const readDisk = options.readDisk ?? (() => { const disk = statfsSync(homedir()); return disk.bavail * disk.bsize; });
  let freeDisk: number | null = null;
  try { freeDisk = readDisk(); } catch { /* unknown holds */ }
  const readCpu = () => platform() === 'win32' ? null : { parallelism: availableParallelism(), load: loadavg() };
  const readMemory = options.readMemory ?? readPlatformHostHeadroom;
  return shareNodeCapacity(assessNodeCapacity(totalmem(), readMemory(), freeDisk,
    light, { readCpu, ...options }), options);
}

/** Observation is advisory; every attempt must acquire an atomic lease before pulling. */
export function shareNodeCapacity(capacity: NodeCapacity, options: CapacityOptions = {}): NodeCapacity {
  if (capacity.held) return capacity;
  try {
    const registry = options.registry ?? hostSlots();
    const available = registry.available(nodeRamSlots(capacity.ramBytes), options.lease);
    const slots = Math.min(capacity.slots, available);
    return { ...capacity, slots, held: slots ? null : 'host-slots-exhausted' };
  } catch { return { ...capacity, slots: 0, held: 'host-slots-unmeasured' }; }
}

/** No shell, network, provider queries or writes. Deltas are calculated by the viewer. */
export function sampleHostStats(): HostStats {
  let diskFree: number | null = null;
  try { const disk = statfsSync(homedir()); diskFree = disk.bavail * disk.bsize; } catch { /* unknown */ }
  const ramTotal = totalmem();
  return { sampledAtMs: Date.now(), uptimeSeconds: uptime(), load: platform() === 'win32' ? [null, null, null] : loadavg(), ramTotal,
    ramUsed: Math.max(0, ramTotal - freemem()), diskFree,
    cores: cpus().map(c => ({ total: Object.values(c.times).reduce((n, t) => n + t, 0), idle: c.times.idle })) };
}
