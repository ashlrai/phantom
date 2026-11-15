/**
 * fleet_self_tick_last — read-only projection of the last self-tick record
 * (queue/self-tick-last.json) over the isolated fleet MCP surface, the same
 * view `ashlr fleet self-tick --last` prints. It never runs a tick, never
 * takes the self-tick lock and never writes: a call only reads what the
 * timer's own run left behind. `last: null` means no recorded run;
 * `{ state: 'unreadable' }` means a present record that failed validation.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readSelfTickLast, type SelfTickLastView } from '../core/fleet/self-tick-last.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

export interface FleetSelfTickLastResult {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
  last: SelfTickLastView | null;
}

export interface FleetSelfTickLastDeps {
  /** Runs root holding queue/self-tick-last.json. Default: ASHLR_RUNS_DIR, then ~/.ashlr-runs (as the CLI resolves it). */
  runsDir?: string;
  now?: () => number;
}

/** The tool takes no arguments; anything else is rejected before a read. */
export function parseFleetSelfTickLastArgs(args: Record<string, unknown> | undefined): Record<string, never> | null {
  return Object.keys(args ?? {}).length === 0 ? {} : null;
}

export async function readFleetSelfTickLast(deps: FleetSelfTickLastDeps = {}): Promise<FleetSelfTickLastResult> {
  const now = deps.now ?? Date.now;
  const runsDir = resolve(deps.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'));
  const at = now();
  return {
    schemaVersion: 1,
    snapshotKind: 'local-persisted',
    authority: 'none',
    generatedAt: new Date(at).toISOString(),
    // The view carries only fixed fields and step names, but step names come
    // from a shared on-disk record: sanitize before it leaves the process.
    last: sanitizePublicJson(readSelfTickLast(runsDir, at)) as SelfTickLastView | null,
  };
}
