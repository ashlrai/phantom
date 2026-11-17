import type { Unknown } from './runtime-identity-model.js';
import { snapshotAge } from './tailnet-peers-model.js';

/** View model for GET /api/verse/fleet/runtime-identity/pool-reach (`reach`). Narrowed locally: the route is a separate change. */
export interface PoolReachHost {
  slot: 'primary' | 'backup';
  alias: string;
  online: boolean | Unknown;
  lastSeen: string;
  ageSeconds: number | Unknown;
  isSelf: boolean;
}
export interface PoolReachView {
  asOf: string;
  self: string;
  role: string;
  hosts: PoolReachHost[];
  /** Host rows dropped because they were malformed. */
  dropped: number;
  reasons: string[];
}
export type PoolReachTone = 'good' | 'warn' | 'bad' | 'unknown';

export const MAX_HOST_ROWS = 4;
export const MAX_REASONS = 5;
export const MAX_TEXT = 120;
export const STALE_SECONDS = 120;

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' && v !== '' ? v.slice(0, MAX_TEXT) : 'unknown');

/**
 * Accepts either the route envelope `{ v, generatedAt, reach }` or a bare reach object.
 * Returns null for anything that is not an object.
 */
export function narrowPoolReach(raw: unknown): PoolReachView | null {
  if (!object(raw)) return null;
  const reach = object(raw.reach) ? raw.reach : raw;
  const rows = Array.isArray(reach.hosts) ? reach.hosts : [];
  const hosts: PoolReachHost[] = [];
  let dropped = 0;
  for (const row of rows.slice(0, MAX_HOST_ROWS)) {
    if (!object(row) || (row.slot !== 'primary' && row.slot !== 'backup') || typeof row.alias !== 'string' || row.alias === '') {
      dropped += 1;
      continue;
    }
    hosts.push({
      slot: row.slot,
      alias: text(row.alias),
      online: typeof row.online === 'boolean' ? row.online : 'unknown',
      lastSeen: text(row.lastSeen),
      ageSeconds: typeof row.ageSeconds === 'number' && Number.isFinite(row.ageSeconds) && row.ageSeconds >= 0 ? row.ageSeconds : 'unknown',
      isSelf: row.isSelf === true,
    });
  }
  return {
    asOf: text(reach.asOf),
    self: text(reach.self),
    role: text(reach.role),
    hosts,
    dropped,
    reasons: Array.isArray(reach.reasons)
      ? reach.reasons.filter((r): r is string => typeof r === 'string' && r !== '').map((r) => r.slice(0, MAX_TEXT))
      : [],
  };
}

/**
 * One-line verdict on failover readiness. A snapshot older than STALE_SECONDS (or with an
 * unreadable asOf, which cannot be vouched for) gets " (stale)" and is never 'good'.
 */
export function poolReachSummary(view: PoolReachView, nowMs: number): { text: string; tone: PoolReachTone } {
  const primary = view.hosts.find((h) => h.slot === 'primary');
  const backup = view.hosts.find((h) => h.slot === 'backup');
  let out: { text: string; tone: PoolReachTone };
  if (view.hosts.length === 0) out = { text: view.reasons[0] ?? 'Pool not configured', tone: 'unknown' };
  else if (primary?.online === false) out = { text: `Primary ${primary.alias} offline`, tone: 'bad' };
  else if (primary?.online !== true) out = { text: `Primary ${primary?.alias ?? 'host'} not confirmed reachable`, tone: 'warn' };
  else if (backup?.online !== true) out = { text: `Backup ${backup?.alias ?? 'host'} not reachable: failover would fail`, tone: 'warn' };
  else out = { text: 'Primary and backup reachable', tone: 'good' };
  const age = snapshotAge(view.asOf, nowMs);
  if (age === 'unknown' || age > STALE_SECONDS) {
    return { text: `${out.text} (stale)`, tone: out.tone === 'good' ? 'warn' : out.tone };
  }
  return out;
}
