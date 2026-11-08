/**
 * runs-job-cost.ts — RQ-APPCOST-11-JOBBREAKDOWN: single-job cost breakdown
 * projection (`fleet.job.cost.v1`), served by GET /api/fleet/job/cost?id=<JOB>
 * on the loopback dashboard and by `phm job cost <id> [--json]`.
 *
 * It answers "what did this job spend, per model call": one row per recorded
 * API call with tokens in/out, model, and cost — or `null`, which every
 * surface renders as 'unknown'. Real numbers only; nothing is fabricated.
 *
 * READ-ONLY GUARDRAILS (same contract as runs-job-detail.ts):
 *  - Bounded fs reads only. Never writes, never spawns a child process,
 *    never touches credentials, provider endpoints or the network.
 *  - Every source is independently guarded: a missing or corrupt file
 *    degrades only its own slice — the projection never invents fields.
 *  - lstat before every read and O_NOFOLLOW on open: a symlinked source is
 *    'degraded', never followed outside runsDir.
 *  - Label fields (model, lane) pass the same safeName grammar the resource
 *    ledger uses; control bytes never survive into the projection.
 *
 * SOURCES (under runsDir — `~/.ashlr-runs` by default):
 *   metrics/api-spend.jsonl  per-call rows: { ts|at|timestamp, job|job_id|id,
 *     lane?, model?, input_tokens, output_tokens, is_error?, cost_usd|usd|cost,
 *     cost_estimated? } — the dispatch collector's spend feed. Rows naming this
 *     job become calls; rows without a usable job id are not attributable and
 *    are never counted.
 *   metrics/jobs.jsonl       lifecycle rows; `finish` events for this job may
 *     carry a worker-reported `tokens_total` — surfaced under jobTotals so a
 *     subscription-lane job with no api-spend rows still shows real numbers.
 *
 * Both ledgers are read from the tail up to a byte cap; `truncated` marks a
 * cut window, meaning older rows for this job may be absent.
 */

import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { isFleetJobId } from './runs-job-detail.js';
import { scrubPrivateText } from '../util/scrub.js';

// ---------------------------------------------------------------------------
// Public types — the fleet.job.cost.v1 wire shape.
// ---------------------------------------------------------------------------

export type FleetJobCostSourceState = 'healthy' | 'missing' | 'degraded';

/** One recorded model call attributable to the job. Null renders 'unknown'. */
export interface FleetJobCallV1 {
  /** ISO timestamp of the call, or null when the row carried none. */
  at: string | null;
  model: string | null;
  lane: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** USD cost reported for this call; null = unknown. */
  costUsd: number | null;
  /** The collector marked the cost an estimate, not a measured price. */
  estimated: boolean;
  /** The row was flagged is_error. */
  error: boolean;
}

export interface FleetJobCostV1 {
  schema: 'fleet.job.cost.v1';
  generatedAt: string;
  job: string;
  /** Per-call rows, oldest first. */
  calls: FleetJobCallV1[];
  totals: {
    calls: number;
    errors: number;
    /** Sum over calls that reported each field; null when none did. */
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
    /** How many calls contributed to each total — partial coverage shows. */
    reported: { inputTokens: number; outputTokens: number; costUsd: number };
  };
  /** Worker-reported totals from finish events in the jobs ledger. */
  jobTotals: { finishes: number; tokensTotal: number | null };
  sources: Record<'apiSpend' | 'jobs', FleetJobCostSourceState>;
  /** A source ledger exceeded its read window; earlier rows may be absent. */
  truncated: boolean;
}

export interface FleetJobCostOptions {
  /** Runs directory. Default `~/.ashlr-runs`. Must be absolute when given. */
  runsDir?: string;
  /** Clock seam for tests. */
  now?: () => Date;
  /** Per-source tail window. Default 4 MiB. */
  maxBytes?: number;
}

// ---------------------------------------------------------------------------
// Constants and small guards
// ---------------------------------------------------------------------------

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const CALLS_MAX = 500;
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;

const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const timestamp = (v: unknown): string | null =>
  typeof v === 'string' && TIMESTAMP.test(v) && Number.isFinite(Date.parse(v)) ? v : null;
const name = (v: unknown): string | null =>
  typeof v === 'string' && SAFE_NAME.test(v) && scrubPrivateText(v) === v ? v : null;
const missing = (e: unknown): boolean =>
  object(e) && e['code'] === 'ENOENT';
const jobRef = (row: Record<string, unknown>): string | null =>
  name(row['job']) ?? name(row['job_id']) ?? name(row['id']);

interface ReadWindow { text: string; truncated: boolean }

/**
 * Bounded, no-follow read. Files larger than `limit` are read from the tail
 * starting at a line boundary; `truncated` marks that window cut. A symlink
 * or non-regular file throws, which the caller degrades rather than follows.
 */
async function readTail(path: string, limit: number): Promise<ReadWindow> {
  const info = await lstat(path);
  if (!info.isFile()) throw new Error('not a regular file');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('not a regular file');
    const start = stat.size > limit ? Math.max(0, stat.size - limit) : 0;
    const buffer = Buffer.alloc(Math.min(stat.size, limit));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, start + offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    let text = buffer.toString('utf8', 0, offset);
    if (start) {
      const newline = text.indexOf('\n');
      text = newline < 0 ? '' : text.slice(newline + 1);
    }
    return { text, truncated: start > 0 };
  } finally {
    await handle.close();
  }
}

function parseRows(text: string): { rows: Record<string, unknown>[]; corrupt: boolean } {
  const rows: Record<string, unknown>[] = [];
  let corrupt = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row: unknown = JSON.parse(line);
      if (!object(row)) { corrupt = true; continue; }
      rows.push(row);
    } catch { corrupt = true; }
  }
  return { rows, corrupt };
}

function callFromRow(row: Record<string, unknown>): FleetJobCallV1 {
  return {
    at: timestamp(row['ts']) ?? timestamp(row['at']) ?? timestamp(row['timestamp']),
    model: name(row['model']),
    lane: name(row['lane']),
    inputTokens: count(row['input_tokens']) ?? count(row['inputTokens']),
    outputTokens: count(row['output_tokens']) ?? count(row['outputTokens']),
    costUsd: count(row['cost_usd']) ?? count(row['usd']) ?? count(row['cost']),
    estimated: row['cost_estimated'] === true,
    error: row['is_error'] === true,
  };
}

// ---------------------------------------------------------------------------
// getFleetJobCost
// ---------------------------------------------------------------------------

export async function getFleetJobCost(job: string, options: FleetJobCostOptions = {}): Promise<FleetJobCostV1> {
  if (!isFleetJobId(job)) throw new Error('invalid fleet job id');
  const runsDir = options.runsDir ?? join(homedir(), '.ashlr-runs');
  if (!isAbsolute(runsDir)) throw new Error('runsDir must be an absolute path');
  const requested = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxBytes = Number.isSafeInteger(requested) && requested > 0 ? requested : DEFAULT_MAX_BYTES;
  const now = (options.now ?? (() => new Date()))();
  const result: FleetJobCostV1 = {
    schema: 'fleet.job.cost.v1',
    generatedAt: now.toISOString(),
    job,
    calls: [],
    totals: { calls: 0, errors: 0, inputTokens: null, outputTokens: null, costUsd: null,
      reported: { inputTokens: 0, outputTokens: 0, costUsd: 0 } },
    jobTotals: { finishes: 0, tokensTotal: null },
    sources: { apiSpend: 'missing', jobs: 'missing' },
    truncated: false,
  };

  await Promise.all([
    (async () => {
      try {
        const window = await readTail(join(runsDir, 'metrics/api-spend.jsonl'), maxBytes);
        result.truncated ||= window.truncated;
        const { rows, corrupt } = parseRows(window.text);
        const calls: FleetJobCallV1[] = [];
        for (const row of rows) {
          if (jobRef(row) !== job) continue;
          calls.push(callFromRow(row));
        }
        calls.sort((a, b) => {
          const am = a.at === null ? Number.POSITIVE_INFINITY : Date.parse(a.at);
          const bm = b.at === null ? Number.POSITIVE_INFINITY : Date.parse(b.at);
          return am - bm;
        });
        result.truncated ||= calls.length > CALLS_MAX;
        result.calls = calls.slice(0, CALLS_MAX);
        for (const call of result.calls) {
          result.totals.calls++;
          if (call.error) result.totals.errors++;
          if (call.inputTokens !== null) { result.totals.inputTokens = (result.totals.inputTokens ?? 0) + call.inputTokens; result.totals.reported.inputTokens++; }
          if (call.outputTokens !== null) { result.totals.outputTokens = (result.totals.outputTokens ?? 0) + call.outputTokens; result.totals.reported.outputTokens++; }
          if (call.costUsd !== null) { result.totals.costUsd = (result.totals.costUsd ?? 0) + call.costUsd; result.totals.reported.costUsd++; }
        }
        result.sources.apiSpend = corrupt ? 'degraded' : 'healthy';
      } catch (e) {
        result.sources.apiSpend = missing(e) ? 'missing' : 'degraded';
      }
    })(),
    (async () => {
      try {
        const window = await readTail(join(runsDir, 'metrics/jobs.jsonl'), maxBytes);
        result.truncated ||= window.truncated;
        const { rows, corrupt } = parseRows(window.text);
        for (const row of rows) {
          if (row['event'] !== 'finish' || jobRef(row) !== job) continue;
          result.jobTotals.finishes++;
          const tokens = count(row['tokens_total']) ?? count(row['tokens']) ?? count(row['total_tokens']);
          if (tokens !== null) result.jobTotals.tokensTotal = (result.jobTotals.tokensTotal ?? 0) + tokens;
        }
        result.sources.jobs = corrupt ? 'degraded' : 'healthy';
      } catch (e) {
        result.sources.jobs = missing(e) ? 'missing' : 'degraded';
      }
    })(),
  ]);
  return result;
}
