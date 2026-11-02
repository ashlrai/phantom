/**
 * `ashlr fleet drip` — READ-ONLY gauge of the merge drip.
 *
 * Finished jobs wait behind a `queue/run/<job>.phdrip` marker while the open
 * Phantom PR count sits at or over the limit. This prints the open count, the
 * limit, how many markers wait and the age of the oldest. A source that could
 * not be read prints `unknown`, never zero. Nothing is written.
 */
import { lstat, readdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultGitRunner } from '../core/verse/git-ops.js';

export const DRIP_PR_LIMIT = 250;
const REPO = 'ashlrai/phantom';
const GH_LIMIT = 1000;
const DAY_MS = 86_400_000;
const USAGE = 'ashlr fleet drip [--json] [--root PATH]\nRead-only: open Phantom PRs vs the limit of 250, and finished jobs waiting behind a queue/run/<job>.phdrip marker.';

export interface FleetDripDeps {
  /** Open PR count, or null when it could not be read. */
  readOpenPrs?: () => Promise<number | null>;
  /** Marker modification times (ms since epoch), or null when the run dir could not be read. */
  readMarkers?: (root: string) => Promise<number[] | null>;
  now?: () => number;
  root?: string;
}

export interface FleetDripReport {
  schema: 'fleet.drip.v1';
  openPrs: number | 'unknown';
  limit: number;
  overLimit: boolean | 'unknown';
  waitingJobs: number | 'unknown';
  oldestMarkerAgeDays: number | 'unknown' | null;
}

async function defaultReadOpenPrs(): Promise<number | null> {
  try {
    const r = await defaultGitRunner('gh', ['pr', 'list', '--repo', REPO, '--state', 'open', '--limit', String(GH_LIMIT), '--json', 'number'], {
      cwd: tmpdir(), timeoutMs: 60_000, maxStdoutBytes: 4 * 1024 * 1024,
    });
    if (r.code !== 0 || r.timedOut || r.truncated) return null;
    const rows: unknown = JSON.parse(r.stdout);
    return Array.isArray(rows) ? rows.length : null;
  } catch { return null; }
}

async function defaultReadMarkers(root: string): Promise<number[] | null> {
  const dir = join(root, 'queue/run');
  try {
    if (!(await lstat(dir)).isDirectory()) return null;
    const times: number[] = [];
    for (const name of await readdir(dir)) {
      if (!name.endsWith('.phdrip') || name.length === '.phdrip'.length) continue;
      const stat = await lstat(join(dir, name));
      if (stat.isFile()) times.push(stat.mtimeMs);
    }
    return times;
  } catch { return null; }
}

export async function buildFleetDrip(root: string, deps: FleetDripDeps = {}): Promise<FleetDripReport> {
  const [open, markers] = await Promise.all([
    (deps.readOpenPrs ?? defaultReadOpenPrs)().catch(() => null),
    (deps.readMarkers ?? defaultReadMarkers)(root).catch(() => null),
  ]);
  const now = (deps.now ?? Date.now)();
  return {
    schema: 'fleet.drip.v1',
    openPrs: open ?? 'unknown',
    limit: DRIP_PR_LIMIT,
    overLimit: open === null ? 'unknown' : open > DRIP_PR_LIMIT,
    waitingJobs: markers === null ? 'unknown' : markers.length,
    // null = readable but nothing waiting, so there is no oldest marker.
    oldestMarkerAgeDays: markers === null ? 'unknown' : markers.length === 0 ? null
      : Math.floor(Math.max(0, now - Math.min(...markers)) / DAY_MS),
  };
}

export function formatFleetDrip(r: FleetDripReport): string {
  const open = r.openPrs === 'unknown' ? 'unknown open PRs' : `${r.openPrs} open PRs`;
  const status = r.overLimit === true ? ' (over the limit)' : '';
  const jobs = r.waitingJobs === 'unknown' ? 'unknown jobs' : `${r.waitingJobs} finished jobs`;
  const oldest = r.oldestMarkerAgeDays === 'unknown' ? ', oldest unknown'
    : r.oldestMarkerAgeDays === null ? '' : `, oldest waiting ${r.oldestMarkerAgeDays}d`;
  return `${open} of ${r.limit}${status}; ${jobs} waiting in the drip${oldest}`;
}

export async function cmdFleetDrip(args: string[], deps: FleetDripDeps = {}): Promise<number> {
  let json = false;
  let root = deps.root ?? join(homedir(), '.ashlr-runs');
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') { console.log(USAGE); return 0; }
    if (arg === '--json' && !json) json = true;
    else if (arg === '--root' && args[i + 1] && !args[i + 1]!.startsWith('--')) root = resolve(args[++i]!);
    else { console.error(`Invalid argument. ${USAGE}`); return 2; }
  }
  const report = await buildFleetDrip(root, deps);
  console.log(json ? JSON.stringify(report) : formatFleetDrip(report));
  return 0;
}
