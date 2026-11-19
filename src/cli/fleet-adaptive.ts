/** `phm fleet adaptive`: per-lane outcome signals for the shared work market's queue/adaptive.json projection. */
import { join } from 'node:path';
import {
  ADAPTIVE_FRESH_SECONDS, ADAPTIVE_SCHEMA, readAdaptiveSignals,
  type AdaptiveReport,
} from '../core/fleet/adaptive-signals.js';
import { runsRoot } from '../core/metrics/loop-collect.js';
import { ensurePrivateDirectory, writePrivateFileAtomic } from '../core/verse/preferences.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const DEFAULT_WINDOW_HOURS = 24;
const MAX_WINDOW_HOURS = 24 * 7;

const USAGE = `Usage: phm fleet adaptive [--window <hours>] [--apply] [--json]
Per-lane outcome signals for the shared work market, computed from metrics/jobs.jsonl
under the runs directory (default: ~/.ashlr-runs, override with ASHLR_RUNS_DIR) over
the last --window hours (default 24, max 168). Read-only unless --apply is given.

Each lane reports launches, finished runs, merged runs and empty finishes, then the
signals queue/adaptive.json carries: empty_rate (empty finishes over finished runs),
yield_rate (merged over launches, the fleet.yield merged_per_launch definition) and
model_latency_s (median model_s on finish rows; null while no finish row reports one —
wall_s is never relabelled as model latency). backoff is always null: it is an
eligibility exclusion only host slot evidence or an operator hold may set.

The shared market (work_market.lane_view) reads queue/adaptive.json only while its ts
is at most ${ADAPTIVE_FRESH_SECONDS} seconds old, so --apply must be republished on a
short timer to stay in force; an older file is ignored, never an error. Signals are
advisory ranking inputs only: they cannot grant a capability, a tier, quota, a hold
exemption or a slot. Missing measurements stay null.

--apply atomically replaces queue/adaptive.json with {ts, lanes}; without it the
command only prints the projection it would write. Exit 0 on success, 2 on usage or
an unreadable ledger (nothing is written from missing data).`;

const pct = (value: number | null): string => value === null ? 'unknown' : `${Math.round(value * 1000) / 10}%`;
const secs = (value: number | null): string => value === null ? 'unknown' : `${Math.round(value)}s`;

function renderAdaptive(report: AdaptiveReport, applied: boolean, path: string): string[] {
  const lines: string[] = [];
  const laneEntries = Object.entries(report.lanes);
  if (!laneEntries.length) {
    lines.push(`No launches in the last ${report.window_hours}h of metrics/jobs.jsonl; the projection carries no lane signals.`);
  } else {
    const launches = laneEntries.reduce((sum, [, l]) => sum + l.launches, 0);
    lines.push(`Adaptive signals over the last ${report.window_hours}h of metrics/jobs.jsonl (${launches} launches, ${laneEntries.length} lanes):`);
    for (const [lane, l] of laneEntries) {
      lines.push(`  ${lane}: yield_rate ${pct(l.yield_rate)} (${l.merged}/${l.launches} launches merged), `
        + `empty_rate ${pct(l.empty_rate)} (${l.empty}/${l.finished} finished), `
        + `model_latency_s ${secs(l.model_latency_s)}`);
    }
  }
  if (report.publish !== null) {
    lines.push(`queue/adaptive.json: ts=${report.publish.ts} (epoch seconds), fresh for ${ADAPTIVE_FRESH_SECONDS}s, ${Object.keys(report.publish.lanes).length} lane(s).`);
  }
  lines.push(applied
    ? `Published ${path}. Republish within ${ADAPTIVE_FRESH_SECONDS}s or the market ignores the projection.`
    : `Dry run — rerun with --apply to publish ${path}. Republish within ${ADAPTIVE_FRESH_SECONDS}s; older projections are ignored.`);
  return lines;
}

/** Read-only unless --apply: computes the market's adaptive.json projection from the job ledger. */
export async function cmdFleetAdaptive(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(USAGE);
    return 0;
  }
  let json = false, apply = false, windowHours: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--apply' && !apply) apply = true;
    else if (arg === '--window' && windowHours === undefined && /^\d+(\.\d+)?$/.test(args[i + 1] ?? '')) {
      windowHours = Number(args[++i]);
      if (windowHours <= 0 || windowHours > MAX_WINDOW_HOURS) { console.error(USAGE); return 2; }
    } else { console.error(USAGE); return 2; }
  }
  const hours = windowHours ?? DEFAULT_WINDOW_HOURS;
  const root = runsRoot();
  const metricsPath = join(root, 'metrics', 'jobs.jsonl');
  const adaptivePath = join(root, 'queue', 'adaptive.json');
  const report = await readAdaptiveSignals(metricsPath, hours, Date.now());
  if (!report.known || report.publish === null) {
    const error = 'Cannot read the job metrics ledger. Expected metrics/jobs.jsonl under the runs directory.';
    console.log(json ? JSON.stringify({ schema: ADAPTIVE_SCHEMA, known: false, error, window_hours: hours }) : error);
    return 2;
  }
  let applied = false;
  if (apply) {
    try {
      ensurePrivateDirectory(join(root, 'queue'));
      writePrivateFileAtomic(adaptivePath, `${JSON.stringify(report.publish, null, 2)}\n`);
      applied = true;
    } catch {
      const error = 'Could not write queue/adaptive.json; check the runs directory is writable.';
      console.log(json ? JSON.stringify({ schema: ADAPTIVE_SCHEMA, known: true, error, window_hours: hours }) : error);
      return 2;
    }
  }
  if (json) console.log(JSON.stringify(sanitizePublicJson({ ...report, applied, path: adaptivePath })));
  else for (const line of renderAdaptive(report, applied, adaptivePath)) console.log(line);
  return 0;
}
