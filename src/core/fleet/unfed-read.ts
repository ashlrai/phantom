/**
 * The shared unfed-capacity read: assembles the `fleet.unfed.v1` report
 * from the dispatcher's published files under the runs root — the one read
 * path `phm fleet unfed` and the fleet MCP `fleet_unfed` tool both serve,
 * so the CLI and MCP can never disagree about what a lane's utilization or
 * unfed verdict means. Read-only: any host capacity lookup is the same
 * bounded local query used by the resource planner. A missing optional input
 * degrades to "reasons unknown", never to a wrong answer; an absent or
 * unreadable queue/status.json throws, and the caller decides how to
 * report the failure.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readTail, runsRoot } from '../metrics/loop-collect.js';
import { readFleetResourcePlan } from '../usage/resource-live/fleet-plan.js';
import {
  currentUnfed, foldClaimOverrides, foldDecisionOutcomes, foldMarketOverrides,
  foldRouteRejections, foldUnfedHistory, readyHints, type UnfedReport,
} from './unfed-capacity.js';

export const UNFED_DEFAULT_WINDOW_HOURS = 24;
export const UNFED_MAX_WINDOW_HOURS = 24 * 7;

const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** router-queue.md is append-mostly Markdown history; give it a wider bound. */
const ROUTER_QUEUE_MAX_BYTES = 32 * 1024 * 1024;
/** The market log is mostly route decisions; the tail bounds the read. */
const HISTORY_TAIL_BYTES = 32 * 1024 * 1024;
/** The jobs ledger carries every lifecycle event; claims fold from its tail. */
const CLAIMS_TAIL_BYTES = 32 * 1024 * 1024;

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

export interface UnfedReadOptions {
  /** Runs root holding queue/ and metrics/. Default: ASHLR_RUNS_DIR, then ~/.ashlr-runs (as the CLI resolves it). */
  runsDir?: string;
  /** Fold window in hours for the history/override/claims/outcome/rejection sections. Default 24. */
  windowHours?: number;
  /** Evaluation clock; defaults to Date.now. */
  now?: () => number;
  readCapacity?: typeof readFleetResourcePlan;
}

/**
 * One unfed report through the shared `fleet.unfed.v1` projection. Throws
 * when queue/status.json is absent or its lanes map cannot be read — the
 * same failure `phm fleet unfed` reports as its exit-2 error — and when a
 * required input exceeds its read bound. Every other input is optional:
 * an unavailable ready.tsv leaves queue-derived counts unknown, a missing market file
 * leaves the matching fold `available: false`, and a tail-truncated jobs
 * ledger marks its claim/outcome counts a lower bound.
 */
export async function readUnfedReport(options: UnfedReadOptions = {}): Promise<UnfedReport> {
  const root = options.runsDir ?? runsRoot();
  const status = await readBounded(join(root, 'queue', 'status.json'));
  if (status === null) throw new Error('unfed-status-unreadable');
  const ready = await readOptional(join(root, 'queue', 'ready.tsv'));
  const [slots, models, budget, adaptive, hold, routerQueue] = await Promise.all([
    readOptional(join(root, 'queue', 'slots.json')),
    readOptional(join(root, 'models.json')),
    readOptional(join(root, 'queue', 'budget-overrides.json')),
    readOptional(join(root, 'queue', 'adaptive.json')),
    readOptional(join(root, 'HOLD')),
    readOptional(join(root, 'queue', 'router-queue.md'), ROUTER_QUEUE_MAX_BYTES),
  ]);
  const nowMs = (options.now ?? Date.now)();
  const [marketRead, jobsRead, capacity] = await Promise.all([
    readTail(join(root, 'metrics', 'work-market.jsonl'), HISTORY_TAIL_BYTES),
    readTail(join(root, 'metrics', 'jobs.jsonl'), CLAIMS_TAIL_BYTES),
    (options.readCapacity ?? readFleetResourcePlan)(root, nowMs).catch(() => null),
  ]);
  const history = marketRead?.text ?? null;
  const jobsText = jobsRead?.text ?? null;
  const window = options.windowHours ?? UNFED_DEFAULT_WINDOW_HOURS;
  const jobsTruncated = jobsRead?.truncated ?? false;
  const current = currentUnfed(status, ready, { slots, models, budget, adaptive, hold, routerQueue, nowMs });
  const advisory = capacity && ready !== null && current.statusFresh ? readyHints(ready, routerQueue) : null;
  return {
    ...current,
    resourcePlan: capacity?.lanes.map(({ lane, running, target_concurrency, additional_slots }) => {
      const readyHere = advisory?.byLane.get(lane) ?? 0;
      return { lane, running, target: target_concurrency,
        unfedSlots: advisory === null || additional_slots === null ? null
          : Math.min(Math.max(0, additional_slots - readyHere), advisory.waiting - readyHere) };
    }) ?? null,
    marketTruncated: marketRead?.truncated ?? false,
    history: foldUnfedHistory(history, nowMs, window),
    overrides: foldMarketOverrides(history, nowMs, window),
    claims: foldClaimOverrides(jobsText, nowMs, window, jobsTruncated),
    decisionOutcomes: foldDecisionOutcomes(history, jobsText, nowMs, window, jobsTruncated),
    rejections: foldRouteRejections(history, nowMs, window),
  };
}
