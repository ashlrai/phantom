/**
 * job-outcomes.ts — collapse metrics/jobs.jsonl into the latest outcome per
 * job, the "recent outcomes" signal queue generators consult before they
 * re-emit a candidate.
 *
 * dispatchd appends one JSON row per event: `finish` rows carry the diff
 * measurement (`empty`), `outcome` rows carry the PR state (`MERGED`). Rows
 * for one job collapse into a single JobOutcome: `merged` is the stronger
 * terminal fact and wins over a stale `empty` flag, and `empty` is the
 * newest boolean `empty` seen (unmeasured rows leave it null, never a guess).
 *
 * Only rows inside `windowMs` of `now` count — older rows are stale evidence
 * and prove nothing about the candidate as it stands now. Malformed lines,
 * missing ids and unparseable or out-of-window timestamps are skipped, never
 * thrown: an unreadable row must not take down generation.
 */
export interface JobOutcome {
  /** Queue job id, e.g. RQ-FIXUP-phantom-1-aaaaaaa. */
  job: string;
  /** Epoch ms of the newest row seen for this job. */
  at: number;
  /** The attempt produced no diff; null when no row measured it. */
  empty: boolean | null;
  /** The job's PR merged. */
  merged: boolean;
}

// The fleet's canonical empty finish kinds (lane-empty-streak.ts EMPTY_KINDS):
// an outcome row naming any of these is a proven empty attempt.
const TERMINAL_EMPTY = new Set(['EMPTY', 'DONE-NOOP', 'EMPTY_DONE', 'SKIPPED-EMPTY']);
const record = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

/**
 * Latest-known outcome per job id. `empty`/`merged` keep their verdicts even
 * when the newest row for the job did not carry that field; `at` always
 * tracks the newest counted row.
 */
export function collapseJobOutcomes(rows: readonly JobOutcome[]): Map<string, JobOutcome> {
  const latest = new Map<string, JobOutcome>();
  for (const row of rows) {
    const prev = latest.get(row.job);
    if (prev === undefined || row.at >= prev.at) {
      latest.set(row.job, {
        job: row.job,
        at: row.at,
        empty: row.merged ? false : row.empty ?? (prev?.empty ?? null),
        merged: row.merged || (prev?.merged ?? false),
      });
    } else if (row.merged) {
      prev.merged = true;
      prev.empty = false;
    } else if (row.empty !== null && prev.empty === null) {
      prev.empty = row.empty;
    }
  }
  return latest;
}

/**
 * Parse jobs.jsonl text. Rows count only when they name a job and carry a
 * timestamp inside (now-windowMs, now]; everything else is skipped so a
 * torn tail or an unrelated metric row can never fabricate evidence.
 */
export function parseJobOutcomeRows(raw: string, now: number, windowMs: number): JobOutcome[] {
  const rows: JobOutcome[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (!record(value)) continue;
    const job = value['job'] ?? value['job_id'] ?? value['jobId'];
    const stamp = value['ts'] ?? value['timestamp'] ?? value['at'];
    const at = typeof stamp === 'string' ? Date.parse(stamp) : NaN;
    if (typeof job !== 'string' || !job || !Number.isFinite(at)) continue;
    if (at < now - windowMs || at > now) continue;
    const outcome = String(value['state'] ?? value['outcome'] ?? value['event'] ?? '').toUpperCase();
    const merged = outcome === 'MERGED' || value['event'] === 'merged';
    const rawEmpty = value['empty'];
    const empty = merged ? false
      : typeof rawEmpty === 'boolean' ? rawEmpty
      : TERMINAL_EMPTY.has(outcome) ? true
      : null;
    rows.push({ job, at, empty, merged });
  }
  return rows;
}
