/** Numeric-only queue projection shared by the app CLI and resource chrome. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getFleetLaneSnapshot } from '../fleet/lane-console.js';

export const RESOURCE_POOLS = ['codex-cmp', 'codex-personal', 'claude', 'claude-api', 'devin', 'omlx', 'codex-local', 'grok'] as const;
export interface AppResource {
  pool: string;
  remainingPercent: number | null;
  resetAt: string | null;
  liveJobs: number | null;
}
export interface AppResources { schema: 'app.resources.v1'; resources: AppResource[] }
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const number = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const instant = (v: unknown): string | null => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;

/** Fixed filenames, bounded handles, no arbitrary strings from disk in the response. */
async function readJson(dir: string, name: string): Promise<Record<string, unknown>> {
  try {
    const file = await open(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 1024 * 1024) return {};
      const bytes = Buffer.alloc(1024 * 1024 + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      return bytesRead > 1024 * 1024 ? {} : object(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')));
    } finally { await file.close(); }
  } catch { return {}; }
}

export async function readAppResources(queueDir = join(homedir(), '.ashlr-runs', 'queue'), now = new Date()): Promise<AppResources> {
  const [lanes, resources, slots, overrides] = await Promise.all([
    getFleetLaneSnapshot({ queueDir, now: () => now, usageLogPaths: [join(queueDir, 'usage-readings.log')] }),
    readJson(queueDir, 'resources.json'), readJson(queueDir, 'slots.json'), readJson(queueDir, 'budget-overrides.json'),
  ]);
  return { schema: 'app.resources.v1', resources: RESOURCE_POOLS.map(pool => {
    const lane = lanes.lanes.find(row => row.lane === pool);
    const reading = object(object(resources.resources)[pool] ?? resources[pool]);
    const override = object(overrides[pool]);
    const candidates = [reading, override];
    let remainingPercent: number | null = null;
    let resetAt: string | null = null;
    for (const row of candidates) {
      const at = instant(row.as_of ?? row.observedAt);
      const reset = instant(row.resetAt ?? row.reset_at);
      const pct = number(row.remainingPercent ?? row.remaining_pct);
      if (at && Date.parse(at) <= now.getTime() && now.getTime() - Date.parse(at) <= 30 * 60_000
        && reset && Date.parse(reset) > now.getTime() && pct !== null && pct <= 100) {
        remainingPercent = pct; resetAt = reset; break;
      }
    }
    const credit = lane?.credit;
    if (remainingPercent === null && credit?.state === 'observed' && credit.observedAt && credit.resetAt
      && Date.parse(credit.observedAt) <= now.getTime() && now.getTime() - Date.parse(credit.observedAt) <= 30 * 60_000
      && Date.parse(credit.resetAt) > now.getTime()) {
      remainingPercent = credit.remainingPct; resetAt = credit.resetAt;
    }
    const slot = object(object(slots.lanes ?? slots)[pool]);
    const running = number(slot.running);
    const liveJobs = running !== null && Number.isSafeInteger(running) ? running : lane?.liveJobs ?? null;
    return { pool, remainingPercent, resetAt, liveJobs };
  }) };
}
