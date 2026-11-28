import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import {
  hasPooledDatedEvent,
  idleLaneAges,
  DEFAULT_STUCK_AFTER_MIN,
  MAX_IDLE_LANE_LEDGER_BYTES,
  readIdleLaneEvents,
  type IdleLaneAge,
} from '../core/fleet/idle-lane-age.js';
import { IDLE_LANES_SCHEMA, parseIdleLanes, type IdleLane } from '../core/fleet/idle-lanes.js';
import { readLedgerTail } from '../core/router/outcomes.js';
export type { IdleLane } from '../core/fleet/idle-lanes.js';

export type IdleLaneReader = (path: string) => Promise<string>;

const usage = `Usage: ashlr fleet idle-lanes [--json]
Read lanes with queued work. Red: room to run. Warn: held. Exit 1 if any lane is red.
Each lane shows the age of its last jobs.jsonl event; a red lane quiet for 30 minutes or more is marked STUCK.
--stuck-after <min>  Mark a red lane STUCK after this many quiet minutes (default 30; the desktop uses 15).`;

async function readBounded(path: string): Promise<string> {
  if (basename(path) === 'jobs.jsonl') {
    const ledger = await readLedgerTail(path, MAX_IDLE_LANE_LEDGER_BYTES);
    return ledger.state === 'read' ? ledger.text : '';
  }
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_IDLE_LANE_LEDGER_BYTES) throw new Error('unreadable or over read bound');
  return readFile(path, 'utf8');
}

/** Read dispatcher observations only; never change holds or launch work. */
export async function cmdFleetIdleLanes(
  args: string[],
  reader: IdleLaneReader = readBounded,
): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(usage);
    return 0;
  }
  const stuckAfterArg = parseStuckAfterArg(args);
  if (stuckAfterArg === 'EXIT2') return 2;
  const stuckAfterMin = stuckAfterArg ?? DEFAULT_STUCK_AFTER_MIN;
  const json = args.includes('--json');
  try {
    const runsDir = process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
    const lanes = parseIdleLanes(await reader(join(runsDir, 'queue', 'status.json')));
    const events = await readIdleLaneEvents(runsDir, reader);
    const rows: Array<IdleLane & Partial<IdleLaneAge>> = hasPooledDatedEvent(events)
      ? idleLaneAges(lanes, events, Date.now(), stuckAfterMin) : lanes;
    if (json) {
      console.log(JSON.stringify({ schema: IDLE_LANES_SCHEMA, lanes: rows, stuckAfterMin }));
    } else {
      console.log(rows.map(lane => {
        const base = `${lane.status}: ${lane.lane}: ${lane.running}/${lane.target} running, ${lane.queued} queued`;
        if (lane.quietMin === undefined) return base;
        return `${base}${lane.quietMin === null ? ', no ledger event' : `, last event ${lane.quietMin}m ago`}${lane.stuck ? ' STUCK' : ''}`;
      }).join('\n') || 'No idle lanes with queued work.');
    }
    return lanes.some(lane => lane.status === 'red') ? 1 : 0;
  } catch {
    const error = 'Cannot read lane status. Expected lanes with held, running, target and queued in queue/status.json under ASHLR_RUNS_DIR (default ~/.ashlr-runs).';
    console.log(json ? JSON.stringify({ schema: IDLE_LANES_SCHEMA, error }) : error);
    return 2;
  }
}

/** Parse `--stuck-after` from args. Returns the numeric value, or 'EXIT2' for bad input. */
function parseStuckAfterArg(args: string[]): number | 'EXIT2' {
  let found = false;
  let jsonSeen = 0;
  let value: number | null = null;
  const consumed = new Set<number>();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--stuck-after') {
      if (found) return 'EXIT2'; // repeated flag
      const raw = args[i + 1];
      if (raw === undefined) return 'EXIT2'; // missing value
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 1440) return 'EXIT2';
      found = true;
      value = n;
      consumed.add(i + 1); // mark the value token so it isn't treated as unknown
      i++; // skip the value token
    } else if (args[i] === '--json') {
      jsonSeen++;
    }
  }
  // Reject unknown or duplicate flags
  if (found || jsonSeen > 0) {
    const known = new Set(['--json', '--stuck-after']);
    for (let i = 0; i < args.length; i++) {
      if (!known.has(args[i]!) && !consumed.has(i)) return 'EXIT2';
    }
    if (jsonSeen > 1) return 'EXIT2'; // duplicate --json
    return value ?? DEFAULT_STUCK_AFTER_MIN;
  }
  if (args.length > 0) return 'EXIT2';
  return DEFAULT_STUCK_AFTER_MIN;
}
