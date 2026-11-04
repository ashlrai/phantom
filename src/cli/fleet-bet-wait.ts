import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sanitizePublicJson } from '../core/util/public-json.js';

export const FLEET_BET_WAIT_SCHEMA = 'fleet.bet-wait.v1';
/** A place past this number is flagged. */
export const FLEET_BET_WAIT_LONG_PLACE = 10;

export interface FleetBetWaitRow {
  id: string;
  lane: string;
  /** 1-based place in the lane; filler counts after all other lines. */
  place: number;
  filler: boolean;
  over: boolean;
}

export interface FleetBetWaitView {
  schema: typeof FLEET_BET_WAIT_SCHEMA;
  readOnly: true;
  threshold: number;
  rows: FleetBetWaitRow[];
}

export interface FleetBetWaitReaders {
  /** ready.tsv contents. */
  ready(): Promise<string>;
  /** router-queue.md contents. */
  routerQueue(): Promise<string>;
}

const USAGE = `Usage: ashlr fleet bet-wait [--json]
For each ready job whose router-queue line has src=leader, print one line: id, lane and its place in that lane. Filler (id ending in A, 6 or more digits, or ending Q8) counts after all other lines. Places over ${FLEET_BET_WAIT_LONG_PLACE} are flagged long. Read-only.
Reads ~/.ashlr-runs/queue/ready.tsv and queue/router-queue.md. Exits 1 when any place is long. Unreadable input exits 2.
Related: ashlr fleet bet-trace, ashlr fleet lane-share.`;

const UNREADABLE = 'Ready list or router queue is unreadable.';

/** Drop control characters so a field stays one plain token. */
function plain(value: string): string {
  return Array.from(value, char => {
    const code = char.codePointAt(0)!;
    return code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029 ? ' ' : char;
  }).join('').trim();
}

export function isFillerId(id: string): boolean {
  return /A$/.test(id) || /\d{6,}/.test(id) || /Q8$/.test(id);
}

/** Ids whose router-queue line carries a whole-token src=leader. */
function leaderIds(queue: string): Set<string> {
  const ids = new Set<string>();
  for (const line of queue.split(/\r?\n/)) {
    if (!/(^|\s)src=leader(?=\s|,|;|$)/.test(line)) continue;
    // Whole-token match: RQ-X-RETRY must not stand in for RQ-X.
    for (const id of line.match(/\bRQ-[A-Za-z0-9_-]+\b/g) ?? []) ids.add(id);
  }
  return ids;
}

export function explainFleetBetWait(readyText: string, queueText: string): FleetBetWaitView {
  const leaders = leaderIds(queueText);
  const entries: { id: string; lane: string; filler: boolean; order: number }[] = [];
  const seen = new Set<string>();
  readyText.split(/\r?\n/).forEach((line, order) => {
    if (!line.trim()) return;
    const fields = line.split('\t').map(plain);
    if (fields[0] === 'READY') fields.shift();
    const [id, , lane] = fields;
    if (!id || !lane || seen.has(id)) return;
    seen.add(id);
    entries.push({ id, lane, filler: isFillerId(id), order });
  });
  const places = new Map<string, number>();
  const rows: FleetBetWaitRow[] = [];
  // Non-filler first, then filler; file order inside each group.
  const ranked = [...entries].sort((a, b) => Number(a.filler) - Number(b.filler) || a.order - b.order);
  for (const entry of ranked) {
    const place = (places.get(entry.lane) ?? 0) + 1;
    places.set(entry.lane, place);
    if (leaders.has(entry.id)) {
      rows.push({ id: entry.id, lane: entry.lane, place, filler: entry.filler, over: place > FLEET_BET_WAIT_LONG_PLACE });
    }
  }
  return { schema: FLEET_BET_WAIT_SCHEMA, readOnly: true, threshold: FLEET_BET_WAIT_LONG_PLACE, rows };
}

function formatFleetBetWait(view: FleetBetWaitView): string {
  if (view.rows.length === 0) return 'No ready leader bets.';
  return view.rows
    .map(row => `${row.id} ${row.lane} place ${row.place}${row.over ? ' long' : ''}`)
    .join('\n');
}

/** Read-only. The injected readers are the only filesystem operations. */
export async function cmdFleetBetWait(
  args: string[],
  readers: FleetBetWaitReaders = {
    ready: () => readFile(join(homedir(), '.ashlr-runs', 'queue', 'ready.tsv'), 'utf8'),
    routerQueue: () => readFile(join(homedir(), '.ashlr-runs', 'queue', 'router-queue.md'), 'utf8'),
  },
): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(USAGE);
    return 0;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) {
    console.error(USAGE);
    return 2;
  }
  const json = args[0] === '--json';
  try {
    const [ready, queue] = await Promise.all([readers.ready(), readers.routerQueue()]);
    const view = sanitizePublicJson(explainFleetBetWait(ready, queue)) as FleetBetWaitView;
    console.log(json ? JSON.stringify(view) : formatFleetBetWait(view));
    return view.rows.some(row => row.over) ? 1 : 0;
  } catch {
    console.log(json ? JSON.stringify({ schema: FLEET_BET_WAIT_SCHEMA, readOnly: true, error: UNREADABLE }) : UNREADABLE);
    return 2;
  }
}
