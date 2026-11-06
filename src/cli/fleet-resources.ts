/**
 * `ashlr fleet resources` — read-only per-lane resource window report.
 *
 * Reads <runsDir>/queue/slots.json for the lanes and their targets, then
 * <runsDir>/queue/resources.json for the router's usage readings:
 *   { "<lane>": { "used_frac": 0..1+, "reset_at": "<iso>" }, ... }
 * (a `lanes` wrapper is accepted for either file, like slots.json itself).
 *
 * One plain line per slots.json lane: target, used_frac — or
 * "unset, router assumes 0.5" when the lane has no reading — and the reset
 * time. Marks `skipped` when used_frac is 1 or more (window exhausted) and
 * `unseen` when a lane with a target above 0 has no resources.json entry.
 * Exits 1 when any lane is unseen, 2 on bad usage; never writes.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { GLOBAL_SLOT_KEYS } from '../core/fleet/runs-lane-targets.js';
import { sanitizePublicJson } from '../core/util/public-json.js';
import { rejectUnknownOptions } from './args.js';

const USAGE = 'Usage: ashlr fleet resources [--runs-dir <abs>] [--json]';
export const FLEET_RESOURCES_SCHEMA = 'fleet.resources.v1';
/** Window fraction the router assumes for a lane resources.json has not seen. */
export const ROUTER_ASSUMED_USED_FRAC = 0.5;

export type FleetResourceStatus = 'ok' | 'skipped' | 'unseen';
export type FleetResourceSourceState = 'healthy' | 'missing' | 'unreadable';

export interface FleetResourceLane {
  lane: string;
  /** slots.json target; null when the row carries no non-negative integer. */
  target: number | null;
  /** Reported window fraction, or null — the router assumes ROUTER_ASSUMED_USED_FRAC. */
  usedFrac: number | null;
  /** ISO reset time from resources.json, or null. */
  resetAt: string | null;
  status: FleetResourceStatus;
}

export interface FleetResourcesView {
  schema: typeof FLEET_RESOURCES_SCHEMA;
  readOnly: true;
  generatedAt: string;
  /** slots.json read state; lanes is empty unless healthy. */
  slots: FleetResourceSourceState;
  /** resources.json read state; anything but healthy means no lane has a reading. */
  resources: FleetResourceSourceState;
  /** Lane names marked unseen (target above 0, no resources.json entry). */
  unseenLanes: string[];
  lanes: FleetResourceLane[];
}

export interface FleetResourcesDeps {
  /** File reader; the only filesystem touch. Defaults to utf8 readFile. */
  read?: (path: string) => Promise<string>;
  /** Default runs dir; a `--runs-dir` flag wins. Then ASHLR_RUNS_DIR, then ~/.ashlr-runs. */
  runsDir?: string;
  now?: () => Date;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const nonNegativeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

/** Drop control characters so a file-held string stays one plain line. */
function plain(value: string): string {
  return Array.from(value, char => {
    const code = char.codePointAt(0)!;
    return code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029 ? ' ' : char;
  }).join('').trim();
}

/** Lane-keyed rows of a queue file: unwrap `lanes`, drop global keys and non-rows. */
function laneRows(raw: unknown): Record<string, Record<string, unknown>> | null {
  if (!record(raw)) return null;
  const map = record(raw.lanes) ? raw.lanes : raw;
  // Null-prototype: a hostile "__proto__" key stays an own property instead of
  // poisoning the lookups done for every other lane.
  const rows: Record<string, Record<string, unknown>> = Object.create(null);
  for (const [lane, row] of Object.entries(map)) {
    if (GLOBAL_SLOT_KEYS.has(lane) || !record(row)) continue;
    rows[lane] = row;
  }
  return rows;
}

async function readLaneRows(read: (path: string) => Promise<string>, path: string): Promise<{ state: FleetResourceSourceState; rows: Record<string, Record<string, unknown>> }> {
  let raw: unknown;
  try {
    raw = JSON.parse(await read(path));
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'unreadable', rows: {} };
  }
  const rows = laneRows(raw);
  return rows === null ? { state: 'unreadable', rows: {} } : { state: 'healthy', rows };
}

/** Epoch-seconds reset times normalize to ISO; out-of-range numbers read as no reset. */
function epochIso(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Project one resources.json entry; only used_frac and reset_at are surfaced. */
function reading(row: Record<string, unknown>): { usedFrac: number | null; resetAt: string | null } {
  const frac = row.used_frac;
  const usedFrac = typeof frac === 'number' && Number.isFinite(frac) && frac >= 0 ? frac : null;
  const reset = row.reset_at;
  const resetAt = typeof reset === 'string' && reset.trim() ? plain(reset) : epochIso(reset);
  return { usedFrac, resetAt };
}

export function buildFleetResourcesView(
  slots: { state: FleetResourceSourceState; rows: Record<string, Record<string, unknown>> },
  resources: { state: FleetResourceSourceState; rows: Record<string, Record<string, unknown>> },
  generatedAt: string,
): FleetResourcesView {
  const lanes: FleetResourceLane[] = Object.entries(slots.rows).map(([name, row]) => {
    const target = nonNegativeInteger(row.target) ? row.target : null;
    const entry = resources.rows[name];
    const { usedFrac, resetAt } = entry ? reading(entry) : { usedFrac: null, resetAt: null };
    const status: FleetResourceStatus = usedFrac !== null && usedFrac >= 1 ? 'skipped'
      : entry === undefined && target !== null && target > 0 ? 'unseen'
      : 'ok';
    return { lane: plain(name), target, usedFrac, resetAt, status };
  });
  return {
    schema: FLEET_RESOURCES_SCHEMA,
    readOnly: true,
    generatedAt,
    slots: slots.state,
    resources: resources.state,
    unseenLanes: lanes.filter(lane => lane.status === 'unseen').map(lane => lane.lane),
    lanes,
  };
}

function formatFleetResources(view: FleetResourcesView): string {
  const lines = view.lanes.map(lane =>
    `${lane.lane}: ${lane.status}; target=${lane.target ?? 'unknown'}; ` +
    `used_frac=${lane.usedFrac ?? `unset, router assumes ${ROUTER_ASSUMED_USED_FRAC}`}; reset=${lane.resetAt ?? 'unknown'}`);
  if (view.slots !== 'healthy') lines.push(`no lanes (slots.json ${view.slots})`);
  else if (view.lanes.length === 0) lines.push('no lanes');
  if (view.slots === 'healthy' && view.resources === 'unreadable') lines.push('resources.json unreadable; every lane reads as unseen');
  return lines.join('\n');
}

export async function cmdFleetResources(args: string[], deps: FleetResourcesDeps = {}): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(`${USAGE}\n` +
      'One line per slots.json lane: target, used_frac (or "unset, router assumes 0.5" without a\n' +
      'resources.json entry) and reset time. "skipped" marks a lane at used_frac 1 or more; "unseen"\n' +
      'marks a lane with target above 0 the router has not reported. Exits 1 on any unseen lane.');
    return 0;
  }
  const bad = rejectUnknownOptions(args, { flags: ['--json'], values: ['--runs-dir'] });
  if (bad) {
    console.error(`error: fleet resources: ${bad.message}\n${USAGE}`);
    return 2;
  }
  let json = false;
  let runsDir = deps.runsDir;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') {
      if (i + 1 < args.length) { console.error(`error: fleet resources: unexpected argument: ${args[i + 1]}\n${USAGE}`); return 2; }
      break;
    }
    if (arg === '--json') json = true;
    else if (arg === '--runs-dir') runsDir = args[++i];
    else {
      console.error(`error: fleet resources: unexpected argument: ${arg}\n${USAGE}`);
      return 2;
    }
  }
  if (runsDir !== undefined && !isAbsolute(runsDir)) {
    console.error(`error: fleet resources: --runs-dir requires an absolute path\n${USAGE}`);
    return 2;
  }
  const queue = join(runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), 'queue');
  const read = deps.read ?? (path => readFile(path, 'utf8'));
  const [slots, resources] = await Promise.all([
    readLaneRows(read, join(queue, 'slots.json')),
    readLaneRows(read, join(queue, 'resources.json')),
  ]);
  const view = sanitizePublicJson(
    buildFleetResourcesView(slots, resources, (deps.now ?? (() => new Date()))().toISOString()),
  ) as FleetResourcesView;
  console.log(json ? JSON.stringify(view) : formatFleetResources(view));
  return view.unseenLanes.length > 0 ? 1 : 0;
}
