import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sanitizePublicJson } from '../core/util/public-json.js';

export const FLEET_TRIM_SCHEMA = 'fleet.trim.v1';
/** A lane needs this many jobs in the 24h rollup before it can be called wasteful. */
export const FLEET_TRIM_MIN_JOBS = 10;
export const FLEET_TRIM_MERGE_RATE_MIN = 0.3;
export const FLEET_TRIM_EMPTY_RATE_MAX = 0.5;

export type FleetTrimFlag = 'starved' | 'wastes';

export interface FleetTrimFlagged {
  lane: string;
  flag: FleetTrimFlag;
  line: string;
}

export interface FleetTrimSuggestion {
  lane: string;
  from: number;
  to: number;
  line: string;
}

export interface FleetTrimReport {
  schema: typeof FLEET_TRIM_SCHEMA;
  readOnly: true;
  flagged: FleetTrimFlagged[];
  suggestions: FleetTrimSuggestion[];
}

export type FleetTrimReader = (path: string) => Promise<string>;

const USAGE = `Usage: ashlr fleet trim [--json]
Read queue/status.json and flag lanes that are starved or waste slots. Read-only.
STARVED: queued work, nothing running, target above 0, not held, and global running at the cap.
WASTES: ${FLEET_TRIM_MIN_JOBS} or more jobs in 24 hours with a merge rate under ${FLEET_TRIM_MERGE_RATE_MIN} or an empty rate over ${FLEET_TRIM_EMPTY_RATE_MAX}.
Each suggestion is a line "SLOTS <lane> <from> -> <to>" that takes one slot from a wasting lane. Nothing is applied.
Related: ashlr fleet admission, ashlr fleet lane-idle.`;

const UNREADABLE = 'Queue status is unreadable or invalid.';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid status');
  return value as Record<string, unknown>;
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid count');
  return value;
}

function rate(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error('Invalid rate');
  return value;
}

/** Drop control characters so a lane name stays one plain token. */
function plain(value: string): string {
  return Array.from(value, char => {
    const code = char.codePointAt(0)!;
    return code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029 ? ' ' : char;
  }).join('').trim().replace(/\s+/g, '_');
}

/** Project only the fields the trim rules need. Never copies the rest of the status file. */
export function trimFleet(value: unknown): FleetTrimReport {
  const status = record(value);
  const admission = record(status.admission);
  const atCap = count(admission.running) >= count(admission.cap);
  // A status file without a rollup has no waste evidence, so no lane can be called wasteful.
  const byLane = status.rollup_24h === undefined ? {} : record(record(status.rollup_24h).by_lane ?? {});
  const flagged: FleetTrimFlagged[] = [];
  const suggestions: FleetTrimSuggestion[] = [];
  for (const [name, row] of Object.entries(record(status.lanes))) {
    const lane = plain(name);
    if (!lane) throw new Error('Invalid lane');
    const fields = record(row);
    const running = count(fields.running);
    const target = count(fields.target);
    const queued = count(fields.queued);
    if (typeof fields.held !== 'boolean') throw new Error('Invalid hold');
    if (queued > 0 && running === 0 && target > 0 && !fields.held && atCap) {
      flagged.push({ lane, flag: 'starved', line: `${lane} is starved: ${queued} queued, none running, the global cap is full.` });
    }
    const rollup = byLane[name];
    if (rollup === undefined) continue;
    const stats = record(rollup);
    const jobs = count(stats.jobs);
    const merged = count(stats.merged);
    const merge = rate(stats.merge_rate);
    const empty = rate(stats.empty_rate);
    if (jobs >= FLEET_TRIM_MIN_JOBS && (merge < FLEET_TRIM_MERGE_RATE_MIN || empty > FLEET_TRIM_EMPTY_RATE_MAX)) {
      flagged.push({
        lane, flag: 'wastes',
        line: `${lane} wastes slots: ${merged} merged of ${jobs} jobs, merge rate ${merge}, empty rate ${empty}.`,
      });
      if (target > 0 && !fields.held) {
        suggestions.push({ lane, from: target, to: target - 1, line: `SLOTS ${lane} ${target} -> ${target - 1}` });
      }
    }
  }
  return { schema: FLEET_TRIM_SCHEMA, readOnly: true, flagged, suggestions };
}

function formatFleetTrim(report: FleetTrimReport): string {
  const lines = [...report.flagged.map(row => row.line), ...report.suggestions.map(row => row.line)];
  return lines.length ? lines.join('\n') : 'No lane is starved or wasting slots.';
}

/** Read-only. The injected reader is the only filesystem operation. */
export async function cmdFleetTrim(
  args: string[],
  reader: FleetTrimReader = path => readFile(path, 'utf8'),
): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(USAGE);
    return 0;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) {
    console.error(USAGE);
    return 2;
  }
  try {
    const report = sanitizePublicJson(trimFleet(JSON.parse(
      await reader(join(homedir(), '.ashlr-runs', 'queue', 'status.json')),
    ))) as FleetTrimReport;
    console.log(args.includes('--json') ? JSON.stringify(report) : formatFleetTrim(report));
    return 0;
  } catch {
    const body = { schema: FLEET_TRIM_SCHEMA, readOnly: true, error: UNREADABLE };
    console.log(args.includes('--json') ? JSON.stringify(body) : UNREADABLE);
    return 2;
  }
}
