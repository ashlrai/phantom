import { isNodePoolLedgerRow } from './jobs-ledger-dialect.js';

const jobPhases = [
  ['queue_wait', 'queued', 'launch', 'Measure admission delays and remove the largest queue bottleneck.'],
  ['checkout', 'launch', 'checkout_complete', 'Profile checkout and reuse safe local worktree preparation.'],
  ['model', 'checkout_complete', 'finish', 'Profile model execution and reduce repeated context and tool work.'],
  ['worker', 'launch', 'finish', 'Profile the full worker slot; checkout and model refine it when their boundaries exist.'],
  ['publish_wait', 'finish', 'publish', 'Profile post-finish publish delay and unblock the publisher.'],
  ['ci', 'ci_start', 'ci_complete', 'Profile CI critical path and eliminate duplicate work.'],
  ['merge', 'ci_complete', 'merged', 'Profile post-CI merge delays and unblock the merge queue.'],
] as const;

type Events = Map<string, number[]>;

/**
 * jobs.jsonl timestamp dialect: ts|timestamp|at|time|mergedAt|closedAt|
 * recordedAt|updatedAt, with mergedAt/closedAt preferred on terminal rows —
 * the same field set dispatchd `_vc_pick` and metrics/loop accept.
 */
const TS_KEYS = ['ts', 'timestamp', 'at', 'time', 'mergedAt', 'closedAt', 'recordedAt', 'updatedAt'] as const;

/** First parseable stamp among the ledger's timestamp fields for one boundary; merged prefers mergedAt, closed closedAt. */
function boundaryTs(row: Record<string, unknown>, event: string): number {
  const preferred = event === 'merged' ? 'mergedAt' : event === 'closed' ? 'closedAt' : null;
  const fields = preferred === null ? TS_KEYS : [preferred, ...TS_KEYS.filter(f => f !== preferred)];
  for (const field of fields) {
    const value = row[field];
    if (typeof value === 'string') {
      const at = Date.parse(value);
      if (Number.isFinite(at)) return at;
    }
  }
  return NaN;
}

/**
 * Canonical boundary name for one ledger row, or undefined when the row is
 * not lifecycle evidence. Terminal PR state outranks the event name: the
 * outcomes reconciler copies the publish row and only swaps the outcome, so
 * `{event:'publish', outcome:'MERGED'}` is merge evidence, never a second
 * publish — and an eventless `{outcome:'MERGED'}` row still counts. `CLOSED`
 * gets its own bucket for the same reason: a closed-PR reconciler row must
 * not read as a second publish. Event dialects fold to the boundary they
 * record: dispatchd writes `enqueue` (the queue-arrival stamp every other
 * ledger reader honors), `published` is the publish spelling visit-sync and
 * dispatchd already normalize, and `PUBLISHED` outcome/status rows are the
 * publish claim the reconciler consumes.
 */
function boundaryEvent(row: Record<string, unknown>): string | undefined {
  const state = String([row.outcome, row.state, row.status, row.phase, row.result, row.conclusion].find(v => typeof v === 'string') ?? '').toUpperCase();
  if (state === 'MERGED') return 'merged';
  if (state === 'CLOSED') return 'closed';
  if (state === 'PUBLISHED') return 'publish';
  const raw = row.event ?? row.type ?? row.kind;
  if (raw === 'enqueue' || raw === 'enqueued') return 'queued';
  if (raw === 'published') return 'publish';
  return typeof raw === 'string' ? raw : undefined;
}

const gitOperations = ['index.lock', 'worktree_add', 'worktree_remove', 'fetch', 'push'] as const;
type GitOperation = typeof gitOperations[number];
type Observation = { machine: string; lane: string; operation: GitOperation; start: number; end: number;
  elapsed: number | null; failed: number | null; retries: number | null };

function gitObservation(row: Record<string, unknown>): Observation | null {
  const operation = gitOperations.find(op => op === row.operation);
  const { machine, lane, elapsed_ms, failed, retries } = row;
  if (!operation || typeof machine !== 'string' || !machine || typeof lane !== 'string' || !lane) return null;
  const elapsed = typeof elapsed_ms === 'number' && Number.isSafeInteger(elapsed_ms) && elapsed_ms >= 0 ? elapsed_ms : null;
  const end = boundaryTs(row, 'git_operation');
  return { machine, lane, operation, start: elapsed === null ? NaN : end - elapsed, end, elapsed,
    failed: typeof failed === 'boolean' ? Number(failed) : null,
    retries: typeof retries === 'number' && Number.isSafeInteger(retries) && retries >= 0 ? retries : null };
}

function p90(samples: number[]) {
  return samples.sort((a, b) => a - b)[Math.ceil(samples.length * 0.9) - 1] ?? null;
}

function sum(samples: (number | null)[]) {
  const known = samples.filter(n => n !== null);
  return { samples: known.length || null, total: known.length ? known.reduce((a, b) => a + b, 0) : null };
}

function summarizeGit(rows: Observation[]) {
  const machines = new Map<string, Observation[]>();
  for (const row of rows) {
    const group = machines.get(row.machine) ?? [];
    group.push(row);
    machines.set(row.machine, group);
  }
  return [...machines].map(([machine, group]) => {
    const concurrent = new Set<Observation>();
    const intervals = group.filter(row => Number.isFinite(row.start) && row.end > row.start).sort((a, b) => a.start - b.start);
    // Earlier starts overlap if the latest end in another lane is still ahead.
    let latest: Observation | undefined, other: Observation | undefined;
    for (const row of intervals) {
      const candidate = latest?.lane === row.lane ? other : latest;
      if (candidate && candidate.end > row.start) concurrent.add(row);
      if (!latest || row.end > latest.end) {
        if (latest?.lane !== row.lane) other = latest;
        latest = row;
      } else if (row.lane !== latest.lane && (!other || row.end > other.end)) other = row;
    }
    // Later starts overlap if the nearest start in another lane is before the end.
    let next: Observation | undefined, nextOther: Observation | undefined;
    for (const row of intervals.reverse()) {
      if (next?.lane !== row.lane) nextOther = next;
      if (nextOther && nextOther.start < row.end) concurrent.add(row);
      next = row;
    }
    return { machine, lanes: [...new Set(group.map(row => row.lane))].sort().map(lane => ({
      lane, operations: gitOperations.map(operation => {
        const samples = group.filter(row => row.lane === lane && row.operation === operation);
        const elapsed = samples.flatMap(row => row.elapsed === null ? [] : [row.elapsed]);
        return { operation, timed_samples: elapsed.length || null, p90_ms: p90(elapsed),
          ...(operation === 'index.lock' ? { failures: sum(samples.map(row => row.failed)) } : {}),
          ...(operation === 'fetch' || operation === 'push' ? { retries: sum(samples.map(row => row.retries)),
            concurrent_retries: sum(samples.filter(row => concurrent.has(row)).map(row => row.retries)) } : {}),
        };
      }),
    })) };
  });
}

/** Pair unique, ordered boundaries within a recorded dispatch attempt when launch evidence exists. */
export function jobLatency(text: string | null, phases: readonly (readonly [string, string, string, string])[] = jobPhases) {
  const jobs = new Map<string, Events>();
  const git: Observation[] = [], recovery = new Map<string, Set<number>>();
  const checkout: number[] = [], recoverySamples: number[] = [];
  let ignored = 0;
  for (const line of (text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      row = value as Record<string, unknown>;
    } catch { ignored++; continue; }
    if (isNodePoolLedgerRow(row)) continue;
    const id = row.job ?? row.job_id ?? row.jobId ?? row.id;
    const event = boundaryEvent(row);
    if (event === 'git_operation') {
      if (phases === jobPhases) {
        const observation = gitObservation(row);
        if (observation) git.push(observation);
        else ignored++;
      }
      continue;
    }
    // Batch members carry their own evidence. The session is a shared worker.
    if (typeof id === 'string' && id.startsWith('RQ-BATCH-')) continue;
    const at = event === undefined ? NaN : boundaryTs(row, event);
    if (typeof id !== 'string' || !id || event === undefined) { ignored++; continue; }
    const events = jobs.get(id) ?? new Map<string, number[]>();
    const times = events.get(event) ?? [];
    if (!Number.isFinite(at)) ignored++;
    if (!times.includes(at)) times.push(at);
    events.set(event, times); jobs.set(id, events);
    if (phases === jobPhases && event === 'checkout_complete' && typeof row.manual_checkout_recovery === 'boolean') {
      const values = recovery.get(id) ?? new Set<number>();
      values.add(Number(row.manual_checkout_recovery));
      recovery.set(id, values);
    }
  }
  const results = phases.map(([phase, start, end, fix]) => {
    const samples: number[] = [];
    for (const [id, events] of jobs) {
      const a = events.get(start), b = events.get(end);
      if (a?.length !== 1 || b?.length !== 1 || !Number.isFinite(a[0]) || !Number.isFinite(b[0]) || b[0]! < a[0]!) continue;
      const from = a[0]!, to = b[0]!;
      if (end !== 'launch' && events.get('launch')?.some(at => from < at && at <= to)) continue;
      samples.push((to - from) / 1000);
      if (phases === jobPhases && phase === 'checkout') {
        checkout.push(to - from);
        const values = recovery.get(id);
        if (values?.size === 1) recoverySamples.push(...values);
      }
    }
    return { phase, measured_jobs: samples.length, missing_jobs: text === null ? null : jobs.size - samples.length,
      total_seconds: samples.length ? samples.reduce((a, b) => a + b, 0) : null, fix_line: fix };
  });
  const recoveries = sum(recoverySamples);
  return { schema: 'fleet.job-latency.v1' as const, known: text !== null, jobs: text === null ? null : jobs.size, ignored_events: text === null ? null : ignored, phases: results,
    ...(phases === jobPhases ? { git_contention: { checkout_p90_ms: p90(checkout), checkout_measured_jobs: checkout.length || null,
      recovery_measured_jobs: recoveries.samples,
      manual_recoveries_per_100_observed_jobs: recoveries.total === null ? null : 100 * recoveries.total / recoverySamples.length,
      machines: git.length ? summarizeGit(git) : null } } : {}),
    top_wastes: results.filter(r => r.total_seconds !== null).sort((a, b) => b.total_seconds! - a.total_seconds!) };
}

/** Existing job boundaries; absent queue admission observations cannot be inferred. */
const mergePhases = [
  ['check_wait', 'publish', 'ci_start', 'Waiting for checks'],
  ['ci', 'ci_start', 'ci_complete', 'Running checks'],
  ['merge', 'ci_complete', 'merged', 'Waiting to merge'],
  ['open_to_merge', 'publish', 'merged', 'PR open to merged across all merge-queue stages'],
] as const;

/** All supplied attempts, independent of ledger line order. JSON contains aggregate metadata only. */
export function mergeQueueLatency(text: string | null) {
  return { ...jobLatency(text, mergePhases), schema: 'pulse.merge-latency.v1' as const };
}
export type PulseMergeLatency = ReturnType<typeof mergeQueueLatency>;
export function mergeQueueLatencyText(report: PulseMergeLatency): string {
  return ['Merge queue stages (all supplied job attempts):', ...report.phases.map(p =>
    `${p.fix_line}: ${p.total_seconds === null ? 'unknown' : `${p.total_seconds}s total observed`} (${p.measured_jobs} measured, ${p.missing_jobs ?? 'unknown'} unknown).`)].join('\n');
}
