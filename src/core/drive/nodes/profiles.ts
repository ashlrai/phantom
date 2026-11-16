import { statfsSync } from 'node:fs';
import { homedir, platform, totalmem } from 'node:os';
import { readMacHostHeadroom, type HostHeadroom } from '../../run/host-headroom.js';
import { assessNodeCapacity, nodeRamSlots, type NodeCapacity } from './capacity.js';
import { NODE_PROFILES, type NodeProfile } from './profile-registry.js';

// Public surface preserved: existing importers of profiles.js keep working.
export { NODE_PROFILES } from './profile-registry.js';
export type { NodeProfile } from './profile-registry.js';

export function nodeProfile(id: string, profiles: readonly NodeProfile[] = NODE_PROFILES): NodeProfile | undefined {
  return profiles.find(p => p.id === id);
}

/** Capability names that mean "serves a local model"; stripped from profiles that forbid local models. */
const LOCAL_MODEL_CAP = /^(local|omlx|mlx|ollama|llama)([:._-]|$)/i;
export function profileCaps(profile: NodeProfile, caps: readonly string[]): string[] {
  return profile.localModels ? [...caps] : caps.filter(c => !LOCAL_MODEL_CAP.test(c));
}

/**
 * RAM-aware lane sizing. Starts from the shared pack-aware budget (host reserve, pressure, disk
 * guards all still apply), then clamps to the profile's agent ceiling and its memory floor.
 * Unmeasured memory holds, like every other node.
 */
export function assessProfileCapacity(profile: NodeProfile, ramBytes: number, memory: HostHeadroom | null, freeDiskBytes: number | null): NodeCapacity {
  const base = assessNodeCapacity(ramBytes, memory, freeDiskBytes);
  if (base.held) return { ...base, slots: 0 };
  const belowFloor = !memory || memory.freePercent < profile.memoryFloorPercent || memory.swapGb > profile.maxSwapGb;
  if (belowFloor) return { ramBytes, slots: 0, held: 'memory-pressure' };
  return { ramBytes, slots: Math.min(profile.maxCliAgents, nodeRamSlots(ramBytes)), held: null };
}

/** Live read for the worker: no shell beyond the fixed vm_stat/sysctl readers in host-headroom. */
export function readProfileCapacity(profile: NodeProfile): NodeCapacity {
  let freeDisk: number | null = null;
  try { const disk = statfsSync(homedir()); freeDisk = disk.bavail * disk.bsize; } catch { /* unknown holds */ }
  return assessProfileCapacity(profile, totalmem(), platform() === 'darwin' ? readMacHostHeadroom() : null, freeDisk);
}
