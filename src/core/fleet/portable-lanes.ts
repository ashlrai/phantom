import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ashlrHome } from '../cloud/store.js';
import { readCustomResources, type CustomResource } from '../usage/resource-live/custom.js';
import { readPrivateJson } from '../usage/resource-live/store.js';
import { RESOURCE_LIVE_ALLOWANCES, type ResourceLiveAllowance } from '../usage/resource-live/types.js';
import { GLOBAL_SLOT_KEYS, LANE_ID_RE } from './runs-lane-targets.js';

const profileLane = z.object({
  id: z.string().regex(LANE_ID_RE).refine(lane => !GLOBAL_SLOT_KEYS.has(lane) && lane !== 'unknown'),
  resource: z.string().regex(/^(?:custom:)?[a-z0-9][a-z0-9-]{0,62}$/),
  label: z.string().trim().min(1).max(80).regex(/^[\p{L}\p{N} ._+&()/·-]+$/u).optional(),
  authorized: z.boolean().default(false),
}).strict();
const profileSchema = z.object({
  schema: z.literal('fleet.profile.v1'),
  lanes: z.array(profileLane).max(64).default([]),
});
const slotSchema = z.object({
  executor_ready: z.literal(true),
  auth_failed: z.boolean().optional(),
  resource_id: z.string().optional(),
  target: z.number().int().nonnegative(),
  ceiling: z.number().int().positive(),
  hard_cap: z.number().int().positive(),
});
const slotsSchema = z.record(z.string(), z.unknown());

export interface PortableFleetLane {
  id: string;
  resource: string;
  label: string;
  provider: string;
  state: 'ready' | 'not-authorized' | 'resource-unavailable' | 'executor-unavailable';
}

export function resolvePortableFleetLanes(profile: unknown, slots: unknown, custom: readonly CustomResource[], now: number): PortableFleetLane[] {
  const parsed = profileSchema.safeParse(profile);
  if (!parsed.success) return [];
  const availableSlots = slotsSchema.safeParse(slots);
  const resources = new Map<string, ResourceLiveAllowance>([...RESOURCE_LIVE_ALLOWANCES, ...custom].map(resource => [resource.id, resource]));
  const ids = new Map<string, number>();
  for (const row of parsed.data.lanes) ids.set(row.id, (ids.get(row.id) ?? 0) + 1);
  return parsed.data.lanes.filter(row => ids.get(row.id) === 1).map(row => {
    const resource = resources.get(row.resource);
    const available = resource && (!resource.expires_at || Date.parse(resource.expires_at) > now)
      && (!resource.custom || resource.custom.kind !== 'metered' || resource.custom.metered_opt_in);
    const slot = slotSchema.safeParse(availableSlots.success && Object.hasOwn(availableSlots.data, row.id)
      ? availableSlots.data[row.id] : null);
    const state = !row.authorized ? 'not-authorized'
      : !available ? 'resource-unavailable'
      : !slot.success || slot.data.auth_failed
        || (slot.data.resource_id ?? (resource?.lane === row.id ? resource.id : undefined)) !== row.resource
        ? 'executor-unavailable' : 'ready';
    return { id: row.id, resource: row.resource, label: row.label ?? resource?.label ?? row.id,
      provider: resource?.custom?.provider ?? resource?.lane ?? 'unknown', state };
  });
}

export async function readPortableFleetLanes(runs = process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs')): Promise<PortableFleetLane[]> {
  const [profile, slots, custom] = await Promise.all([
    readPrivateJson(join(ashlrHome(), 'fleet-profile.json'), 64 * 1024),
    readPrivateJson(join(runs, 'queue', 'slots.json'), 128 * 1024),
    readCustomResources(),
  ]);
  return resolvePortableFleetLanes(profile, slots, custom, Date.now());
}
