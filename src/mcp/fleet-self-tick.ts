/**
 * Read-only self-tick last-run projection over the MCP tool surface. It never
 * runs a tick and never takes the self-tick lock — a call only reads the
 * record the timer's own write left.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readSelfTickLast, type SelfTickLastView } from '../core/fleet/self-tick-last.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

/** Runs root holding queue/self-tick-last.json. Default: ASHLR_RUNS_DIR, then ~/.ashlr-runs. */
function defaultRunsDir(): string {
  return process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
}

export interface FleetSelfTickLastResult {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
  last: SelfTickLastView | null;
}

export interface FleetSelfTickDeps {
  runsDir?: string;
  now?: () => number;
  selfTick?: (runsDir: string, now: number) => SelfTickLastView | null;
}

export function readFleetSelfTickLast(deps?: FleetSelfTickDeps): FleetSelfTickLastResult {
  const now = deps?.now ?? Date.now;
  const runsDir = deps?.runsDir ?? defaultRunsDir();
  const reader = deps?.selfTick ?? readSelfTickLast;
  const last = reader(runsDir, now());
  return {
    schemaVersion: 1,
    snapshotKind: 'local-persisted',
    authority: 'none',
    generatedAt: new Date().toISOString(),
    last: sanitizePublicJson(last) as SelfTickLastView | null,
  };
}
