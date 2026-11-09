/**
 * `phm fleet hold-check` — read-only: which lanes are held, and may each one
 * still spend usage?
 *
 * Reads <runsDir>/HOLD (the global hold switch), <runsDir>/queue/slots.json
 * (per-lane `held`) and <runsDir>/queue/resources.json (`used_frac` per lane).
 * Usage is `eligible` below 1, `exhausted` at 1 or more, and `unknown` when
 * resources.json is missing or malformed or the lane has no valid reading;
 * unknown is never treated as eligible. Exits 1 when HOLD is on or any lane is
 * held, 2 on bad usage; never writes. Runs dir: ASHLR_RUNS_DIR, else ~/.ashlr-runs.
 */
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readLaneTargets } from '../core/fleet/runs-lane-targets.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const USAGE = 'Usage: phm fleet hold-check [--json]';
export const FLEET_HOLD_CHECK_SCHEMA = 'fleet.hold-check.v1';

export type HoldCheckSource = 'healthy' | 'missing' | 'unreadable';
export type UsageEligibility = 'eligible' | 'exhausted' | 'unknown';

export interface HoldCheckLane {
  lane: string;
  held: boolean;
  heldReason: string | null;
  heldUntil: string | null;
  usedFrac: number | null;
  usage: UsageEligibility;
}

export interface HoldCheckView {
  schema: typeof FLEET_HOLD_CHECK_SCHEMA;
  readOnly: true;
  generatedAt: string;
  /** True when the global HOLD file exists; null when it could not be read. */
  hold: boolean | null;
  slots: HoldCheckSource;
  usageSource: HoldCheckSource;
  heldLanes: string[];
  lanes: HoldCheckLane[];
}

export interface HoldCheckOptions {
  runsDir?: string;
  now?: () => Date;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Per-lane used_frac; the whole map is null when the file is missing or malformed. */
async function readUsage(runsDir: string): Promise<{ state: HoldCheckSource; fracs: Map<string, number> }> {
  const fracs = new Map<string, number>();
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(runsDir, 'queue', 'resources.json'), 'utf8'));
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'unreadable', fracs };
  }
  if (!isRecord(raw)) return { state: 'unreadable', fracs };
  for (const [lane, row] of Object.entries(isRecord(raw.lanes) ? raw.lanes : raw)) {
    const frac = isRecord(row) ? row.used_frac : undefined;
    if (typeof frac === 'number' && Number.isFinite(frac) && frac >= 0) fracs.set(lane, frac);
  }
  return { state: 'healthy', fracs };
}

async function readHold(runsDir: string): Promise<boolean | null> {
  try {
    await stat(join(runsDir, 'HOLD'));
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? false : null;
  }
}

/** Typed API for agents; the CLI below only prints this. */
export async function checkFleetHold(opts: HoldCheckOptions = {}): Promise<HoldCheckView> {
  const runsDir = opts.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const [targets, usage, hold] = await Promise.all([
    readLaneTargets({ runsDir, now: opts.now }),
    readUsage(runsDir),
    readHold(runsDir),
  ]);
  const lanes: HoldCheckLane[] = targets.lanes.map(row => {
    const usedFrac = usage.fracs.get(row.lane) ?? null;
    return {
      lane: row.lane,
      held: row.held,
      heldReason: row.heldReason,
      heldUntil: row.heldUntil,
      usedFrac,
      usage: usedFrac === null ? 'unknown' : usedFrac >= 1 ? 'exhausted' : 'eligible',
    };
  });
  return {
    schema: FLEET_HOLD_CHECK_SCHEMA,
    readOnly: true,
    generatedAt: targets.generatedAt,
    hold,
    slots: targets.sourceState === 'healthy' ? 'healthy' : targets.sourceState === 'missing' ? 'missing' : 'unreadable',
    usageSource: usage.state,
    heldLanes: lanes.filter(l => l.held).map(l => l.lane),
    lanes,
  };
}

function format(view: HoldCheckView): string {
  const lines = [`HOLD: ${view.hold === null ? 'unknown' : view.hold ? 'on' : 'off'}`];
  if (view.slots !== 'healthy') lines.push(`no lanes (slots.json ${view.slots})`);
  for (const l of view.lanes) {
    lines.push(`${l.lane}: ${l.held ? `held${l.heldReason ? ` (${l.heldReason})` : ''}` : 'not held'}; usage ${l.usage}` +
      (l.usedFrac === null ? '' : ` (used_frac=${l.usedFrac})`));
  }
  if (view.usageSource !== 'healthy') lines.push(`resources.json ${view.usageSource}; usage is unknown for every lane`);
  return lines.join('\n');
}

export async function cmdFleetHoldCheck(args: string[], opts: HoldCheckOptions = {}): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(`${USAGE}\nShows HOLD, each held lane, and whether its usage window is eligible, exhausted or unknown.\n` +
      'Reads ASHLR_RUNS_DIR (default ~/.ashlr-runs). Exits 1 when HOLD is on or any lane is held.');
    return 0;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) {
    console.error(`error: fleet hold-check: unexpected argument\n${USAGE}`);
    return 2;
  }
  const view = sanitizePublicJson(await checkFleetHold(opts)) as HoldCheckView;
  console.log(args[0] === '--json' ? JSON.stringify(view) : format(view));
  return view.hold === true || view.heldLanes.length > 0 ? 1 : 0;
}
