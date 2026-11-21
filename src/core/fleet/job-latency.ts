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
  const state = String(row.outcome ?? row.state ?? row.status ?? '').toUpperCase();
  if (state === 'MERGED') return 'merged';
  if (state === 'CLOSED') return 'closed';
  if (state === 'PUBLISHED') return 'publish';
  const raw = row.event ?? row.type;
  if (raw === 'enqueue' || raw === 'enqueued') return 'queued';
  if (raw === 'published') return 'publish';
  return typeof raw === 'string' ? raw : undefined;
}

/** A job ID must identify one attempt; ambiguous repeated boundaries are never paired. */
export function jobLatency(text: string | null, phases: readonly (readonly [string, string, string, string])[] = jobPhases) {
  const jobs = new Map<string, Events>();
  let ignored = 0;
  for (const line of (text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      row = value as Record<string, unknown>;
    } catch { ignored++; continue; }
    const id = row.job ?? row.job_id ?? row.jobId ?? row.id;
    const event = boundaryEvent(row);
    const time = event === 'merged' && row.mergedAt !== undefined ? row.mergedAt : row.ts ?? row.timestamp ?? row.at;
    const at = typeof time === 'string' ? Date.parse(time) : NaN;
    if (typeof id !== 'string' || !id || event === undefined) { ignored++; continue; }
    const events = jobs.get(id) ?? new Map<string, number[]>();
    const times = events.get(event) ?? [];
    if (!Number.isFinite(at)) ignored++;
    if (!times.includes(at)) times.push(at);
    events.set(event, times); jobs.set(id, events);
  }
  const results = phases.map(([phase, start, end, fix]) => {
    const samples: number[] = [];
    for (const events of jobs.values()) {
      const a = events.get(start), b = events.get(end);
      if (a?.length === 1 && b?.length === 1 && Number.isFinite(a[0]) && Number.isFinite(b[0]) && b[0]! >= a[0]!) samples.push((b[0]! - a[0]!) / 1000);
    }
    return { phase, measured_jobs: samples.length, missing_jobs: text === null ? null : jobs.size - samples.length,
      total_seconds: samples.length ? samples.reduce((a, b) => a + b, 0) : null, fix_line: fix };
  });
  return { schema: 'fleet.job-latency.v1' as const, known: text !== null, jobs: text === null ? null : jobs.size, ignored_events: text === null ? null : ignored, phases: results,
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
