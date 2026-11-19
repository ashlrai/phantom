import { join } from 'node:path';
import { foldLaneOverrides, renderLaneOverrides } from '../core/fleet/lane-overrides.js';
import { readTail, runsRoot } from '../core/metrics/loop-collect.js';

/** The market log is mostly route decisions; the tail bounds the read. */
const HISTORY_TAIL_BYTES = 32 * 1024 * 1024;
const DEFAULT_WINDOW_HOURS = 24;
const MAX_WINDOW_HOURS = 24 * 7;

const USAGE = `Usage: phm fleet lane-overrides [--window <hours>] [--json]
Per-job lane-override accounting for the shared work market: how many jobs the market placed off their preferred_lane hint in the last <hours> (default 24, max 168), why (resource_fit, preferred_lane_fallback, unknown_preference), which lanes refused the hint and with which reason codes, and which jobs found no runnable lane. Folds route_decision rows from metrics/work-market.jsonl under ~/.ashlr-runs (override with ASHLR_RUNS_DIR); only each job's latest in-window decision counts.
Read-only: no writes, no child processes, no network.
Exit 0 when the journal was read, 1 when metrics/work-market.jsonl is absent or unreadable.`;

/** Read-only: folds the market's own route_decision ledger into per-job override counts. */
export async function cmdFleetLaneOverrides(args: string[]): Promise<number> {
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
      if (windowHours <= 0 || windowHours > MAX_WINDOW_HOURS) { console.error(USAGE); return 2; }
    } else { console.error(USAGE); return 2; }
  }
  const root = runsRoot();
  const text = await readTail(join(root, 'metrics', 'work-market.jsonl'), HISTORY_TAIL_BYTES);
  const report = foldLaneOverrides(text, Date.now(), windowHours ?? DEFAULT_WINDOW_HOURS);
  if (json) console.log(JSON.stringify(report));
  else for (const line of renderLaneOverrides(report)) console.log(line);
  return report.available ? 0 : 1;
}
