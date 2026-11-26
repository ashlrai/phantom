import { renderUnfed, unfedExitCode, FLEET_UNFED_SCHEMA, type UnfedReport } from '../core/fleet/unfed-capacity.js';
import { UNFED_MAX_WINDOW_HOURS, readUnfedReport } from '../core/fleet/unfed-read.js';
import { runsRoot } from '../core/metrics/loop-collect.js';

const USAGE = `Usage: phm fleet unfed [--window <hours>] [--json]
Per-resource utilization of the shared work queue, unfed capacity: lanes with free slots while ready rows wait under another lane's hint, with reason codes, and lane-override accounting over the window — once over market decisions and once over recorded claim launches. When the dispatcher does not publish its own verdict, codes are recomputed from queue/slots.json, models.json, queue/budget-overrides.json, queue/adaptive.json, queue/router-queue.md and HOLD under ~/.ashlr-runs (override with ASHLR_RUNS_DIR). Also folds the last <hours> (default 24, max 168) of unfed ticks and route decisions from metrics/work-market.jsonl — overrides, per-lane rejections and decision outcomes — and claim launches from the tail of metrics/jobs.jsonl.
Also compares running jobs and unfilled slots with the advisory targets from phm resources plan. The report carries status.json's last_tick as statusAsOf and flags statusFresh false when the tick is older than two minutes, in the future, or missing — a stale snapshot is reported as the last published state, never as live. Read-only: no writes or provider calls.
Exit 1 when fresh status shows an unfed lane, 0 when it shows none, and 2 when the current verdict is unknown.`;

/** Read-only: never changes holds, hints or launches work. */
export async function cmdFleetUnfed(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(USAGE);
    return 0;
  }
  let json = false;
  let windowHours: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--window' && windowHours === undefined && /^\d+(\.\d+)?$/.test(args[i + 1] ?? '')) {
      windowHours = Number(args[++i]);
      if (windowHours <= 0 || windowHours > UNFED_MAX_WINDOW_HOURS) { console.error(USAGE); return 2; }
    } else { console.error(USAGE); return 2; }
  }
  let report: UnfedReport;
  try {
    report = await readUnfedReport({ runsDir: runsRoot(), windowHours });
  } catch {
    const error = 'Cannot read lane status. Expected lanes with running and target in queue/status.json.';
    console.log(json ? JSON.stringify({ schema: FLEET_UNFED_SCHEMA, readOnly: true, error }) : error);
    return 2;
  }
  if (json) console.log(JSON.stringify(report));
  else for (const line of renderUnfed(report)) console.log(line);
  return unfedExitCode(report);
}
