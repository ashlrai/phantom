import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  hasPooledDatedEvent,
  idleLaneAges,
  DEFAULT_STUCK_AFTER_MIN,
  type IdleLaneAge,
} from '../core/fleet/idle-lane-age.js';
import { IDLE_LANES_SCHEMA, parseIdleLanes, type IdleLane } from '../core/fleet/idle-lanes.js';
import { parseJobsJsonl } from '../core/fleet/lane-console.js';
export type { IdleLane } from '../core/fleet/idle-lanes.js';

export type IdleLaneReader = (path: string) => Promise<string>;

// Same bound lane-console puts on jobs.jsonl.
const MAX_LEDGER_FILE_BYTES = 8 * 1024 * 1024;

async function readBounded(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_LEDGER_FILE_BYTES) throw new Error('unreadable or over read bound');
  return readFile(path, 'utf8');
}

/** Read dispatcher observations only; never change holds or launch work. */
export async function cmdFleetIdleLanes(
  args: string[],
  reader: IdleLaneReader = readBounded,
): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(
      'Usage: ashlr fleet idle-lanes [--json]\n' +
        'Read lanes with queued work. Red: room to run. Warn: held. Exit 1 if any lane is red.\n' +
        'Each lane shows the age of its last jobs.jsonl event; a red lane quiet for 30 minutes or more is marked STUCK.\n' +
        '--stuck-after <min>  Mark a red lane STUCK after this many quiet minutes (default 30; the desktop uses 15).',
    );
    return 0;
  }
  const stuckAfterArg = parseStuckAfterArg(args);
  if (stuckAfterArg === 'EXIT2') return 2;
  const stuckAfterMin = stuckAfterArg ?? DEFAULT_STUCK_AFTER_MIN;
  const json = args.includes('--json');
  try {
    const queueDir = join(homedir(), '.ashlr-runs', 'queue');
    const lanes = parseIdleLanes(await reader(join(queueDir, 'status.json')));
    // Age is advisory: a missing, oversized or corrupt ledger never fails the command.
    let aged: IdleLaneAge[] | null = null;
    try {
      const text = await reader(join(queueDir, 'jobs.jsonl'));
      if (text.length <= MAX_LEDGER_FILE_BYTES) {
        const { events } = parseJobsJsonl(text);
        // Without a single dated, pooled event the ledger tells us nothing; keep the plain output.
        if (hasPooledDatedEvent(events)) aged = idleLaneAges(lanes, events, Date.now(), stuckAfterMin);
      }
    } catch { /* ages stay unknown */ }
    const rows: Array<IdleLane & Partial<IdleLaneAge>> = aged ?? lanes;
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
    const error = 'Cannot read lane status. Expected lanes with held, running, target and queued in ~/.ashlr-runs/queue/status.json.';
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
