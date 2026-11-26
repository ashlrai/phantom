import { statfsSync } from 'node:fs';
import { isIP } from 'node:net';
import { homedir, totalmem } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ashlrHome } from '../../cloud/store.js';
import { readPlatformHostHeadroom, type HostHeadroom } from '../../run/host-headroom.js';
import { readPrivateFileCapped } from '../../verse/preferences.js';
import { assessNodeCapacity, nodeRamSlots, type NodeCapacity } from './capacity.js';
import { validId } from './state.js';

/**
 * Declared per-host node profile. Static data: a profile never grants authority, joins a node or
 * opens a port. It only bounds what a host may advertise and gives the roster a name to show when
 * the host has not joined or has gone quiet. Reachability is tailnet-only by policy; `tailnetIp`
 * is informational and nothing in this module connects to it.
 */
export interface NodeProfile {
  /** Registry node id passed to `phm node join --node`. */
  id: string;
  label: string;
  hostname: string;
  tailnetIp: string;
  owners: readonly string[];
  /** Physical RAM the profile was sized for; sizing still uses the live `totalmem()`. */
  ramBytes: number;
  /** Hard ceiling on concurrent CLI agents regardless of free RAM. */
  maxCliAgents: number;
  /** When false the node never advertises local model lanes (oMLX or other). */
  localModels: boolean;
  /** Admission needs at least this much unallocated RAM (percent of physical) ... */
  memoryFloorPercent: number;
  /** ... and no more than this much swap in use (GiB). */
  maxSwapGb: number;
}

const nodeSchema = z.object({
  id: z.string().refine(validId),
  label: z.string().trim().min(1).max(80).regex(/^[\p{L}\p{N} ._+&()/·-]+$/u),
  hostname: z.string().min(1).max(253).regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/),
  tailnetIp: z.string().refine(ip => isIP(ip) !== 0),
  owners: z.array(z.string().refine(validId)).max(64),
  ramBytes: z.number().int().positive(),
  maxCliAgents: z.number().int().nonnegative(),
  localModels: z.boolean(),
  memoryFloorPercent: z.number().min(0).max(100),
  maxSwapGb: z.number().nonnegative(),
}).strict();
const fleetProfile = z.object({ schema: z.literal('fleet.profile.v1'), nodes: z.array(nodeSchema).max(64) });

export function readConfiguredNodeProfiles(path = join(ashlrHome(), 'fleet-profile.json')): NodeProfile[] {
  try {
    const file = readPrivateFileCapped(path, 64 * 1024);
    if (!file || file.truncated) return [];
    const parsed = fleetProfile.safeParse(JSON.parse(file.text));
    if (!parsed.success) return [];
    const nodes = parsed.data.nodes;
    return new Set(nodes.map(node => node.id)).size === nodes.length ? nodes : [];
  } catch {
    return [];
  }
}

export function nodeProfile(id: string, profiles: readonly NodeProfile[] = readConfiguredNodeProfiles()): NodeProfile | undefined {
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
  return assessProfileCapacity(profile, totalmem(), readPlatformHostHeadroom(), freeDisk);
}
