/**
 * `ashlr fleet brains` — read-only liveness view of the fleet's thinking
 * parts. The executor, Opus leader, Sol, the Claude orchestrator and
 * AUTOAUTHOR can each die without notice; this answers "when did each one
 * last act?" from the tail of ~/.ashlr-runs/queue/dispatch-events.log.
 *
 * Row attribution (kind token after the `YYYY-MM-DD HH:MM:SS` stamp):
 *   LEADER …                  → executor
 *   OPUS-LEADER …             → opus-leader
 *   AUTOAUTHOR …              → autoauthor
 *   ORCH-JOB … from sol       → sol
 *   ORCH-JOB … from claude    → claude-orchestrator
 *
 * A brain is stale when its newest attributed event is older than 90
 * minutes — or no event was found at all. A missing or unreadable log
 * reports every brain unknown; the command is a view, never a gate, and
 * exits 0 either way. Read-only: bounded tail, symlink refused.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { localTimestamp, readSource, type Source } from '../core/fleet/runs-parked-queue.js';

export const FLEET_BRAINS_STALE_MINUTES = 90;
export const FLEET_BRAINS_MAX_TAIL_BYTES = 5 * 1024 * 1024;

export interface FleetBrainRow {
  brain: string;
  /** ISO instant of the newest attributed event in the retained tail; null when none. */
  lastEventAt: string | null;
  /** Whole minutes since lastEventAt; null when the brain was never seen. */
  ageMinutes: number | null;
  /** true when the newest event is older than staleMinutes — or there is none. */
  stale: boolean;
}
export interface FleetBrainsV1 {
  schema: 'fleet.brains.v1';
  generatedAt: string;
  /** State of the dispatch-events read; 'missing' still yields rows (all unknown). */
  source: Source;
  staleMinutes: number;
  /** Event-shaped lines skipped for a bad shape or bad timestamp. */
  malformedLines: number;
  brains: FleetBrainRow[];
}
export interface FleetBrainsOptions { runsRoot?: string; now?: number }

const EVENT_ROW = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([A-Z][A-Z0-9_-]{0,63})(?: (.*))?$/;
const DATE_SHAPED = /^\d{4}-\d{2}-\d{2} /;
const FROM_SOL = /\bfrom\s+sol\b/i;
const FROM_CLAUDE = /\bfrom\s+claude\b/i;
const BRAINS: ReadonlyArray<{ name: string; match: (kind: string, rest: string) => boolean }> = [
  { name: 'executor', match: (kind) => kind === 'LEADER' },
  { name: 'opus-leader', match: (kind) => kind === 'OPUS-LEADER' },
  { name: 'autoauthor', match: (kind) => kind === 'AUTOAUTHOR' },
  { name: 'sol', match: (kind, rest) => kind === 'ORCH-JOB' && FROM_SOL.test(rest) },
  { name: 'claude-orchestrator', match: (kind, rest) => kind === 'ORCH-JOB' && FROM_CLAUDE.test(rest) },
];

/** Newest attributed event per brain over the retained tail. Pure; no IO. */
export function fleetBrains(text: string, nowMs: number): { brains: FleetBrainRow[]; malformedLines: number } {
  const newest = new Map<string, { at: string; ms: number }>();
  let malformedLines = 0;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;
    const m = EVENT_ROW.exec(line);
    if (!m) {
      if (DATE_SHAPED.test(line)) malformedLines++;
      continue;
    }
    const stamp = localTimestamp(`${m[1]} ${m[2]}`);
    // Bad dates are malformed; future rows cannot be ordered against now.
    if (!Number.isFinite(stamp.ms)) { malformedLines++; continue; }
    if (stamp.ms > nowMs) continue;
    const kind = m[3]!;
    const rest = m[4] ?? '';
    for (const brain of BRAINS) {
      if (!brain.match(kind, rest)) continue;
      const seen = newest.get(brain.name);
      if (!seen || stamp.ms >= seen.ms) newest.set(brain.name, { at: stamp.at, ms: stamp.ms });
    }
  }
  return {
    malformedLines,
    brains: BRAINS.map(({ name }) => {
      const seen = newest.get(name);
      if (!seen) return { brain: name, lastEventAt: null, ageMinutes: null, stale: true };
      const ageMs = nowMs - seen.ms;
      return {
        brain: name,
        lastEventAt: seen.at,
        ageMinutes: Math.floor(ageMs / 60_000),
        stale: ageMs > FLEET_BRAINS_STALE_MINUTES * 60_000,
      };
    }),
  };
}

export async function readFleetBrains(opts: FleetBrainsOptions = {}): Promise<FleetBrainsV1> {
  const now = opts.now ?? Date.now();
  const root = opts.runsRoot ?? join(homedir(), '.ashlr-runs');
  const source = await readSource(join(root, 'queue', 'dispatch-events.log'), FLEET_BRAINS_MAX_TAIL_BYTES, true);
  const parsed = fleetBrains(source.text, now);
  return {
    schema: 'fleet.brains.v1',
    generatedAt: new Date(now).toISOString(),
    source: source.state,
    staleMinutes: FLEET_BRAINS_STALE_MINUTES,
    malformedLines: parsed.malformedLines,
    brains: parsed.brains,
  };
}

export async function cmdFleetBrains(args: string[], opts: FleetBrainsOptions = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log('ashlr fleet brains [--json]\n' +
      'Read-only last-action view of the fleet brains from the dispatch-events tail.\n' +
      'Stale means nothing attributed within 90 minutes; a missing log reports every brain unknown.');
    return 0;
  }
  let json = false;
  for (const arg of args) {
    if (arg === '--json' && !json) json = true;
    else return 2;
  }
  const report = await readFleetBrains(opts);
  if (json) console.log(JSON.stringify(report));
  else console.log(report.brains.map((row) => row.lastEventAt === null
    ? `${row.brain}: unknown`
    : `${row.brain}: ${row.stale ? 'stale' : 'fresh'} (last ${row.lastEventAt}, ${row.ageMinutes}m ago)`).join('\n'));
  return 0;
}
