/**
 * Memory pressure throttles the lanes that use this Mac's memory, not the cloud lanes.
 * `decideLaneMemory` is the one pure rule (the host daemon can call it too); `readLanePressure`
 * is the impure read behind `phm lanes pressure`. Read-only: it never writes slots.json.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readLaneTargets, LANE_ID_RE, type LaneTargetRow } from './runs-lane-targets.js';
import { readHostMemory, REAL_PRESSURE_FREE_PCT, SWAP_GROWING_MB_PER_MIN, type HostMemoryDeps } from './host-memory.js';
import { defaultRunsDir } from './host-top.js';
import { readPauseState, pauseLine, type PauseState } from './pause-state.js';

export const LANE_PRESSURE_SCHEMA = 'lanes.pressure.v1';
/** Free memory under this percent is critical. Warning starts at REAL_PRESSURE_FREE_PCT (35). */
export const CRITICAL_FREE_PCT = 15;
/** Local lanes sit at half for this long at warning, then drop to their floor. */
export const LOCAL_FLOOR_AFTER_MINUTES = 10;

export type MemoryClass = 'local' | 'cloud';
export type PressureLevel = 'normal' | 'warning' | 'critical' | 'unknown';

/** Lanes whose model runs on this Mac unless lane config says otherwise. Everything else is cloud. */
const DEFAULT_LOCAL_LANES: ReadonlySet<string> = new Set(['codex-local']);

/** The configured class (`memory_class` in queue/slots.json) wins; otherwise codex-local is local and the rest are cloud. */
export function laneMemoryClass(lane: string, configured?: unknown): MemoryClass {
  if (configured === 'local' || configured === 'cloud') return configured;
  return DEFAULT_LOCAL_LANES.has(lane) ? 'local' : 'cloud';
}

export interface MemoryReading { freePercent: number | null; swapGrowthMbPerMin: number | null; swapoutsPerMin: number | null }

/**
 * Pure. Critical: free memory under 15%, or swap growing fast while memory is already short (swap growth
 * with free memory is a false alarm, see host-memory.ts). Warning: under 35% free or memory being swapped out.
 * Unknown free memory is never treated as pressure.
 */
export function pressureLevel(m: MemoryReading): PressureLevel {
  const { freePercent: free, swapGrowthMbPerMin: growth, swapoutsPerMin: outs } = m;
  if (free === null) return 'unknown';
  if (free < CRITICAL_FREE_PCT) return 'critical';
  const short = free < REAL_PRESSURE_FREE_PCT;
  if (short && growth !== null && growth >= SWAP_GROWING_MB_PER_MIN) return 'critical';
  return short || (outs !== null && outs > 0) ? 'warning' : 'normal';
}

export interface LaneMemoryInput {
  lane: string;
  target: number;
  floor: number;
  /** Configured class; anything but 'local' or 'cloud' is ignored and the default applies. */
  memoryClass?: unknown;
}
export interface LaneMemoryOptions {
  /** How long the level has been warning; local lanes drop from half to their floor after 10 minutes. Default 0. */
  warningMinutes?: number;
}
export interface LaneMemoryDecision {
  lane: string;
  class: MemoryClass;
  level: PressureLevel;
  target: number;
  /** Workers this lane may run now. Equals `target` when memory is not throttling it. */
  allowed: number;
  throttled: boolean;
}

/**
 * Pure: the whole rule.
 * warning: local lanes go to half (never under their floor), then to the floor; cloud lanes keep their target.
 * critical: local lanes go to 0 new launches; cloud lanes go to half (never under their floor, never above target).
 * normal or unknown: every lane keeps its target, which is also how a lane recovers.
 */
export function decideLaneMemory(level: PressureLevel, lane: LaneMemoryInput, opts: LaneMemoryOptions = {}): LaneMemoryDecision {
  const cls = laneMemoryClass(lane.lane, lane.memoryClass);
  const target = Math.max(0, lane.target);
  const floor = Math.min(Math.max(0, lane.floor), target);
  const half = Math.max(floor, Math.floor(target / 2));
  let allowed = target;
  if (level === 'critical') allowed = cls === 'local' ? 0 : Math.max(floor, Math.ceil(target / 2));
  else if (level === 'warning' && cls === 'local') allowed = (opts.warningMinutes ?? 0) >= LOCAL_FLOOR_AFTER_MINUTES ? floor : half;
  allowed = Math.min(allowed, target);
  return { lane: lane.lane, class: cls, level, target, allowed, throttled: allowed < target };
}

/** One plain sentence per lane, e.g. "codex-local: held at 2, memory 31% free (warning)". */
export function laneMemoryLine(d: LaneMemoryDecision, freePercent: number | null): string {
  const mem = freePercent === null ? 'memory reading unavailable' : `memory ${freePercent}% free`;
  if (d.throttled) {
    const tail = d.allowed === 0 ? ', no new launches' : '';
    return `${d.lane}: held at ${d.allowed}${d.allowed === d.target ? '' : ` of ${d.target}`}, ${mem} (${d.level})${tail}`;
  }
  if (d.level === 'warning' && d.class === 'cloud') return `${d.lane}: not throttled, cloud lane (${mem}, warning)`;
  if (d.level === 'warning') return `${d.lane}: not throttled, already at its floor of ${d.target} (${mem}, warning)`;
  if (d.class === 'cloud') return `${d.lane}: not throttled, cloud lane`;
  return `${d.lane}: not throttled, ${mem}`;
}

export interface LanePressureRow extends LaneMemoryDecision { reason: string }
export interface LanePressureReport {
  schema: typeof LANE_PRESSURE_SCHEMA;
  asOf: string;
  level: PressureLevel;
  freePercent: number | null;
  swapGrowthMbPerMin: number | null;
  lanes: LanePressureRow[];
  /** PAUSE and PAUSE_LOCAL, and the plain-words line for them (null when neither is on). */
  pause?: PauseState;
  pauseLine?: string | null;
  gaps: string[];
}

/** Pure: canned readings in, one typed report out. */
export function buildLanePressure(input: {
  now: number; memory: MemoryReading; lanes: Array<LaneMemoryInput>; warningMinutes?: number; gaps?: string[];
}): LanePressureReport {
  const level = pressureLevel(input.memory);
  const gaps = [...(input.gaps ?? [])];
  if (level === 'unknown') gaps.push('Free memory is unknown, so no lane is throttled.');
  const lanes = input.lanes
    .map(lane => decideLaneMemory(level, lane, { warningMinutes: input.warningMinutes }))
    .sort((a, b) => a.lane.localeCompare(b.lane))
    .map(d => ({ ...d, reason: laneMemoryLine(d, input.memory.freePercent) }));
  return {
    schema: LANE_PRESSURE_SCHEMA, asOf: new Date(input.now).toISOString(), level,
    freePercent: input.memory.freePercent, swapGrowthMbPerMin: input.memory.swapGrowthMbPerMin, lanes, gaps,
  };
}

/** `memory_class` per lane from queue/slots.json; an unreadable file means every lane uses the default class. */
async function readConfiguredClasses(runsDir: string): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  try {
    const raw: unknown = JSON.parse(await readFile(join(runsDir, 'queue', 'slots.json'), 'utf8'));
    const lanes = raw && typeof raw === 'object' && 'lanes' in raw ? (raw as { lanes: unknown }).lanes : raw;
    if (lanes && typeof lanes === 'object') {
      for (const [lane, row] of Object.entries(lanes)) {
        if (LANE_ID_RE.test(lane) && row && typeof row === 'object') out.set(lane, (row as Record<string, unknown>).memory_class);
      }
    }
  } catch { /* Defaults apply. */ }
  return out;
}

export interface ReadLanePressureDeps extends HostMemoryDeps { readTargets?: () => Promise<{ sourceState: string; lanes: LaneTargetRow[] }> }

/** The one impure entry: reads memory and lane targets, then hands them to buildLanePressure. Never throws, never writes. */
export async function readLanePressure(deps: ReadLanePressureDeps = {}): Promise<LanePressureReport> {
  const runsDir = deps.runsDir ?? defaultRunsDir();
  const [memory, targets, classes, pause] = await Promise.all([
    readHostMemory({ ...deps, runsDir }),
    (deps.readTargets ?? (() => readLaneTargets({ runsDir })))(),
    readConfiguredClasses(runsDir),
    readPauseState({}, runsDir),
  ]);
  const gaps: string[] = [];
  if (targets.sourceState !== 'healthy') gaps.push(`Lane targets are ${targets.sourceState}: queue/slots.json could not be read, so no lanes are listed.`);
  return { ...buildLanePressure({
    now: (deps.now ?? Date.now)(), gaps,
    memory: { freePercent: memory.freePercent, swapGrowthMbPerMin: memory.swapGrowthMbPerMin, swapoutsPerMin: memory.swapoutsPerMin },
    lanes: targets.lanes.map(row => ({ lane: row.lane, target: row.target, floor: row.floor, memoryClass: classes.get(row.lane) })),
  }), pause, pauseLine: pauseLine(pause) };
}
