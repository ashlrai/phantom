/**
 * launchable.ts — core planner behind `phm fleet launchable`: per-lane count
 * of ready rows that can actually start, compared with each lane's free
 * launch slots.
 *
 * Ready rows are admitted exactly like the shared work market sees them:
 * `parseReadyMarketRows` applies the dispatcher's own checks — job id, repo
 * shape, market tier, requirements cell or the router-queue.md envelope for
 * a spec-less row — so a row the market would reject is dead work, never
 * launchable, and each surviving row counts toward the lane its resolved
 * hint names (requirements `preferred_lane` wins over the lane column; an
 * explicit null or empty lane cell is lane-open supply any lane may take).
 * On top of that the launch-specific fences apply: jobs marked `drop` or
 * `defer` in queue/skipped-empty.tsv never launch, filler rows wait while
 * queue/FILLER_HOLD exists, and a row whose prompt file is absent cannot
 * start. `free` counts against the launch target — the configured target
 * tightened by the controller's effective_target shed — so a shed lane has
 * no phantom room.
 */
import { laneLaunchTarget } from './lane-launch-target.js';
import { FILLER_ID } from './lane-starve.js';
import { parseReadyMarketRows } from './unfed-market.js';

export interface LaunchableLane {
  lane: string;
  running: number;
  /** The launch target: configured target tightened by the controller's effective_target shed. */
  target: number;
  free: number;
  launchable: number;
}

export interface LaunchablePlan {
  /** Lanes sorted by name; `launchable` counts only rows whose prompt file exists. */
  lanes: LaunchableLane[];
  /** Lane-open rows whose prompt file exists — shared supply any lane may take. */
  openRows: number;
}

export interface LaunchableInputs {
  /** queue/status.json text: lanes with running, target and optional effective_target. */
  statusJson: string;
  /** queue/ready.tsv text; '' when absent. */
  readyTsv: string;
  /** queue/router-queue.md text; resolves spec-less rows' requirement envelopes. */
  routerQueue?: string | null;
  /** queue/skipped-empty.tsv text; '' when absent. */
  skippedEmpty?: string | null;
}

export interface LaunchableOptions {
  /** queue/FILLER_HOLD exists: filler rows are held. */
  fillerHold?: boolean;
  /** Prompt path -> whether the file exists; the only IO the plan needs. */
  promptExists: (path: string) => boolean | Promise<boolean>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * Job ids queue/skipped-empty.tsv marks `drop` or `defer` — the empty-run
 * gate's declines. Columns are `time, job, decision, reason`; anything else
 * is not an exclusion.
 */
function dropDeferIds(skippedEmpty: string | null | undefined): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const line of (skippedEmpty ?? '').split('\n')) {
    const cols = line.split('\t');
    const decision = cols[2]?.trim();
    if (cols[1] && (decision === 'drop' || decision === 'defer')) ids.add(cols[1].trim());
  }
  return ids;
}

/**
 * The launchable supply plan. Throws on an unreadable status snapshot —
 * the CLI reports that as its exit-2 failure; every other input degrades
 * to fewer counted rows, never to invented supply.
 */
export async function planLaunchable(
  inputs: LaunchableInputs,
  options: LaunchableOptions,
): Promise<LaunchablePlan> {
  const data: unknown = JSON.parse(inputs.statusJson);
  if (!isRecord(data) || !isRecord(data.lanes)) throw new Error('invalid status');
  const lanes = new Map<string, LaunchableLane>();
  for (const [lane, value] of Object.entries(data.lanes)) {
    if (!isRecord(value) || !count(value.running) || !count(value.target)) throw new Error('invalid lane');
    const target = laneLaunchTarget(value.target, count(value.effective_target) ? value.effective_target : null);
    lanes.set(lane, { lane, running: value.running, target, free: Math.max(0, target - value.running), launchable: 0 });
  }
  const excluded = dropDeferIds(inputs.skippedEmpty);
  const fillerHold = options.fillerHold === true;
  let openRows = 0;
  for (const row of parseReadyMarketRows(inputs.readyTsv, inputs.routerQueue).rows) {
    if (excluded.has(row.id) || (fillerHold && FILLER_ID.test(row.id))) continue;
    if (!(await options.promptExists(row.prompt))) continue;
    if (row.hint === null) { openRows++; continue; }
    const entry = lanes.get(row.hint);
    if (entry !== undefined) entry.launchable++;
  }
  return { lanes: [...lanes.values()].sort((a, b) => a.lane.localeCompare(b.lane)), openRows };
}
