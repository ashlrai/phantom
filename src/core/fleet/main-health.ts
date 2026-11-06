/**
 * Read-only view of the main-guardian status table
 * (`<runs>/supervisor/status-main-guardian.md`): which repo's default branch is
 * red, what failed, and which fix jobs are open. Parsing is pure and never
 * throws; the reader is bounded and writes nothing.
 */
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { localTimestamp, readSource } from './runs-parked-queue.js';

export const MAIN_HEALTH_STALE_MS = 30 * 60_000;
const MAX_STATUS_BYTES = 256 * 1024;
const MAX_ROWS = 64;
const MAX_CELL = 200;
const SHA = /^[0-9a-f]{7,40}$/i;
const HEADING = /^# Main guardian status \((\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)(?: [A-Za-z]{1,5})?\)/m;

export interface FleetMainHealthRepo {
  repo: string;
  branch: string;
  sha: string | null;
  state: 'green' | 'red' | 'unknown';
  checkedAt: string | null;
  failingCheck: string | null;
  fixJobs: string[];
  nightlyRed: string | null;
}
export interface FleetMainHealthV1 {
  v: 1;
  generatedAt: string;
  source: 'ok' | 'unavailable';
  statusAt: string | null;
  stale: boolean;
  guardianOff: boolean;
  red: number;
  repos: FleetMainHealthRepo[];
}

// eslint-disable-next-line no-control-regex -- table cells must not carry control bytes.
const cell = (raw: string | undefined): string => (raw ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, MAX_CELL);
const orNull = (value: string): string | null => value || null;

/** Pure: the table in `text`, with the staleness verdict taken against `nowMs`. */
export function parseMainGuardianStatus(text: string, nowMs: number): Omit<FleetMainHealthV1, 'source' | 'guardianOff'> {
  const heading = HEADING.exec(text);
  const stamp = heading ? localTimestamp(heading[1]!) : null;
  const statusMs = stamp && Number.isFinite(stamp.ms) ? stamp.ms : null;
  const repos: FleetMainHealthRepo[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (repos.length >= MAX_ROWS) break;
    if (!line.startsWith('|')) continue;
    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell);
    if (cells.length < 4 || !cells[0] || !cells[1] || cells[0] === 'repo' || /^[-:\s]+$/.test(cells.slice(0, 2).join(''))) continue;
    const state = cells[3]!.toLowerCase();
    const checked = cells[4] ? localTimestamp(cells[4]) : null;
    repos.push({
      repo: cells[0],
      branch: cells[1],
      sha: SHA.test(cells[2]!) ? cells[2]! : null,
      state: state === 'green' || state === 'red' ? state : 'unknown',
      checkedAt: checked && Number.isFinite(checked.ms) ? checked.at : null,
      failingCheck: orNull(cells[5] ?? ''),
      fixJobs: (cells[6] ?? '').split(/[,\s]+/).filter(Boolean),
      nightlyRed: orNull(cells[7] ?? ''),
    });
  }
  return {
    v: 1,
    generatedAt: new Date(nowMs).toISOString(),
    statusAt: stamp && statusMs !== null ? stamp.at : null,
    stale: statusMs === null || nowMs - statusMs > MAIN_HEALTH_STALE_MS,
    red: repos.filter((repo) => repo.state === 'red').length,
    repos,
  };
}

export async function readFleetMainHealth(opts: { runsDir?: string; now?: () => number } = {}): Promise<FleetMainHealthV1> {
  const now = (opts.now ?? Date.now)();
  const root = opts.runsDir ?? join(homedir(), '.ashlr-runs');
  const [source, off] = await Promise.all([
    readSource(join(root, 'supervisor', 'status-main-guardian.md'), MAX_STATUS_BYTES, false),
    stat(join(root, 'queue', 'MAIN_GUARDIAN_OFF')).then(() => true, () => false),
  ]);
  if (source.state !== 'healthy') {
    return { v: 1, generatedAt: new Date(now).toISOString(), source: 'unavailable', statusAt: null, stale: true, guardianOff: off, red: 0, repos: [] };
  }
  return { ...parseMainGuardianStatus(source.text, now), source: 'ok', guardianOff: off };
}
