import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { currentUnfed, foldClaimOverrides, foldDecisionOutcomes, foldMarketOverrides, foldUnfedHistory, renderUnfed, FLEET_UNFED_SCHEMA, type UnfedReport } from '../core/fleet/unfed-capacity.js';
import { readTail, runsRoot } from '../core/metrics/loop-collect.js';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** router-queue.md is append-mostly Markdown history; give it a wider bound. */
const ROUTER_QUEUE_MAX_BYTES = 32 * 1024 * 1024;
/** The market log is mostly route decisions; the tail bounds the read. */
const HISTORY_TAIL_BYTES = 32 * 1024 * 1024;
/** The jobs ledger carries every lifecycle event; claims fold from its tail. */
const CLAIMS_TAIL_BYTES = 32 * 1024 * 1024;
const DEFAULT_WINDOW_HOURS = 24;
const MAX_WINDOW_HOURS = 24 * 7;

const USAGE = `Usage: phm fleet unfed [--window <hours>] [--json]
Per-resource utilization of the shared work queue, unfed capacity: lanes with free slots while ready rows wait under another lane's hint, with reason codes, and lane-override accounting over the window — once over market decisions and once over recorded claim launches. When the dispatcher does not publish its own verdict, codes are recomputed from queue/slots.json, models.json, queue/budget-overrides.json, queue/adaptive.json, queue/router-queue.md and HOLD under ~/.ashlr-runs (override with ASHLR_RUNS_DIR). Also folds the last <hours> (default 24, max 168) of unfed ticks and route decisions from metrics/work-market.jsonl, and claim launches from the tail of metrics/jobs.jsonl.
Reads queue/status.json, queue/ready.tsv, queue/slots.json, models.json, queue/budget-overrides.json, queue/adaptive.json, queue/router-queue.md, HOLD, metrics/work-market.jsonl and metrics/jobs.jsonl under ~/.ashlr-runs (override with ASHLR_RUNS_DIR). The report carries status.json's last_tick as statusAsOf and flags statusFresh false when the tick is older than two minutes, in the future, or missing — the same freshness rule the spend projection uses; a stale snapshot is reported as the last published state, never as live. Read-only: no writes, no child processes, no network.
Exit 1 when any lane is unfed now, 2 when status.json is unreadable.`;

async function readBounded(path: string, maxBytes = MAX_FILE_BYTES): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > maxBytes) throw new Error('unreadable or over read bound');
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Optional market inputs: any read failure degrades to "reasons unknown", never to a wrong answer. */
async function readOptional(path: string, maxBytes = MAX_FILE_BYTES): Promise<string | null> {
  try {
    return await readBounded(path, maxBytes);
  } catch {
    return null;
  }
}

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
      if (windowHours <= 0 || windowHours > MAX_WINDOW_HOURS) { console.error(USAGE); return 2; }
    } else { console.error(USAGE); return 2; }
  }
  const root = runsRoot();
  let report: UnfedReport;
  try {
    const status = await readBounded(join(root, 'queue', 'status.json'));
    if (status === null) throw new Error('no status');
    const ready = (await readBounded(join(root, 'queue', 'ready.tsv'))) ?? '';
    const [slots, models, budget, adaptive, hold, routerQueue] = await Promise.all([
      readOptional(join(root, 'queue', 'slots.json')),
      readOptional(join(root, 'models.json')),
      readOptional(join(root, 'queue', 'budget-overrides.json')),
      readOptional(join(root, 'queue', 'adaptive.json')),
      readOptional(join(root, 'HOLD')),
      readOptional(join(root, 'queue', 'router-queue.md'), ROUTER_QUEUE_MAX_BYTES),
    ]);
    const history = await readTail(join(root, 'metrics', 'work-market.jsonl'), HISTORY_TAIL_BYTES);
    const jobsPath = join(root, 'metrics', 'jobs.jsonl');
    const jobsText = await readTail(jobsPath, CLAIMS_TAIL_BYTES);
    // Stat after the tail read: the append-only ledger only grows, so a size
    // over the bound here means the folded claims are a lower bound.
    const jobsInfo = await stat(jobsPath).catch(() => null);
    const nowMs = Date.now();
    const window = windowHours ?? DEFAULT_WINDOW_HOURS;
    const jobsTruncated = jobsInfo !== null && jobsInfo.isFile() && jobsInfo.size > CLAIMS_TAIL_BYTES;
    report = {
      ...currentUnfed(status, ready, { slots, models, budget, adaptive, hold, routerQueue, nowMs }),
      history: foldUnfedHistory(history, nowMs, window),
      overrides: foldMarketOverrides(history, nowMs, window),
      claims: foldClaimOverrides(jobsText, nowMs, window, jobsTruncated),
      decisionOutcomes: foldDecisionOutcomes(history, jobsText, nowMs, window, jobsTruncated),
    };
  } catch {
    const error = 'Cannot read lane status. Expected lanes with running and target in queue/status.json.';
    console.log(json ? JSON.stringify({ schema: FLEET_UNFED_SCHEMA, readOnly: true, error }) : error);
    return 2;
  }
  if (json) console.log(JSON.stringify(report));
  else for (const line of renderUnfed(report)) console.log(line);
  return report.unfedLanes.length > 0 ? 1 : 0;
}
