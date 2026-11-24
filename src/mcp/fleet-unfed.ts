/**
 * `fleet_unfed` MCP adapter: the shared work queue's per-resource
 * utilization and unfed-capacity read — `readUnfedReport`, the same
 * assembly `phm fleet unfed --json` serves: each lane's running/target,
 * utilization, headroom and the ready rows waiting under another lane's
 * hint (`fleet.unfed.v1`'s `resources`, `waiting`, `unfedLanes`,
 * `unfedSlots`, `fleetStop`, `statusAsOf`/`statusFresh`), plus the window
 * folds — unfed ticks, route-decision overrides and rejections, claim
 * launches that left their hint, and decided-job outcomes.
 * `fleet_lanes` reports each lane's posture (running/target/hold/usage)
 * and `fleet_work_feed` lists the jobs themselves; neither answers "which
 * lanes have free slots while runnable rows wait under another lane's
 * hint, and why" — the starvation picture an agent planning where work
 * can run needed a shell-out for.
 *
 * `windowHours` is the only argument — the same fold window `--window`
 * takes (any finite number above 0 up to the shared 168-hour cap;
 * omitted means the 24-hour default). Every store
 * root stays server-owned: no caller root, path, cwd or runsDir is
 * accepted, and the tool never writes, launches, holds or releases
 * anything. Read-only honesty is the report's own: `source`
 * dispatcher/derived, `statusFresh` null-or-boolean, each fold's
 * `available`/`truncated` flags and `decisionOutcomes.jobsAvailable` keep
 * missing or tail-truncated evidence unknown — never an invented zero —
 * and a missing or unreadable queue/status.json reports `unavailable`,
 * never an invented all-fed fleet. Lane names, reason codes and counts
 * are the dispatcher's published aggregates; no job ids, task text or
 * credentials enter the projection.
 */
import {
  UNFED_MAX_WINDOW_HOURS, readUnfedReport,
} from '../core/fleet/unfed-read.js';
import type { UnfedReport } from '../core/fleet/unfed-capacity.js';

const UNFED_KEYS = new Set(['windowHours']);

export interface FleetUnfedArgs {
  /** Fold window in hours for the history/override/claims/outcome/rejection sections; omitted means 24. */
  windowHours?: number;
}

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. Only
 * `windowHours` is accepted — a finite number above 0 up to the shared
 * 168-hour cap, the same bound `phm fleet unfed --window` enforces.
 * Unknown keys, caller roots, paths, wrong types and out-of-range values
 * are all refused before any store read.
 */
export function parseFleetUnfedArgs(args: Record<string, unknown>): FleetUnfedArgs | null {
  if (Object.keys(args).some(key => !UNFED_KEYS.has(key))) return null;
  const windowHours = args.windowHours;
  if (windowHours === undefined) return {};
  if (typeof windowHours !== 'number' || !Number.isFinite(windowHours)
      || windowHours <= 0 || windowHours > UNFED_MAX_WINDOW_HOURS) return null;
  return { windowHours };
}

export interface FleetUnfedDeps {
  /** Report reader; defaults to the shared `readUnfedReport` assembly `phm fleet unfed` runs. */
  report?: (input: FleetUnfedArgs) => Promise<UnfedReport>;
}

interface FleetUnfedMeta {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
}

/** The shared `fleet.unfed.v1` report with the MCP envelope metadata on every member. */
export type FleetUnfedResult = FleetUnfedMeta & (
  | UnfedReport
  | { status: 'unavailable'; reason: 'unfed-read-unavailable' }
);

/**
 * One unfed read through the shared `readUnfedReport` assembly — the
 * identical files, bounds, folds and freshness verdict `phm fleet unfed
 * --json` computes, so CLI and MCP can never disagree. The report's own
 * `schema`, `readOnly`, `source`, `statusAsOf`/`statusFresh` and per-fold
 * availability flags ride beside the envelope's `generatedAt`. A
 * throwing read — absent or unreadable queue/status.json, an over-bound
 * input, a malformed lanes map — reports `unavailable`, never an
 * invented all-fed fleet.
 */
export async function readFleetUnfed(
  input: FleetUnfedArgs = {},
  deps: FleetUnfedDeps = {},
): Promise<FleetUnfedResult> {
  const meta: FleetUnfedMeta = {
    schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
    generatedAt: new Date().toISOString(),
  };
  const read = deps.report ?? ((i: FleetUnfedArgs) => readUnfedReport({ windowHours: i.windowHours }));
  try {
    return { ...meta, ...(await read(input)) };
  } catch {
    return { ...meta, status: 'unavailable' as const, reason: 'unfed-read-unavailable' as const };
  }
}
