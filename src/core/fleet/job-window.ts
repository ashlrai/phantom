/**
 * job-window.ts — one job's facts as one window (`fleet.job.window.v1`):
 * the shape `phm job show`, GET /api/fleet/job/window and the desktop and
 * phone job window all read, so every surface says the same thing.
 *
 * Pure and browser-safe: no node imports, no clock reads, no I/O. The
 * reader (runs-job-window.ts) gathers the facts; the desktop falls back to
 * building the same window from an older `fleet.job.v1` detail.
 *
 * Rules:
 *  - A fact with no evidence is null on the wire and "unknown" in words.
 *    Nothing is guessed: no lane, model or repo is inferred.
 *  - One state, in plain words: running, finished with a PR, finished with
 *    nothing, stopped, or unknown. A published result wins over a stop (the
 *    worker got its result out before it was stopped).
 *  - Log lines are taken as given. Callers redact them first
 *    (scrubJobLogLine); this module never sees raw log bytes.
 */

export const JOB_WINDOW_SCHEMA = 'fleet.job.window.v1';

export type JobWindowState = 'running' | 'finished-pr' | 'finished-empty' | 'stopped' | 'unknown';

/** What a reader knows about one job. Every field but `job` may be missing. */
export interface JobWindowFacts {
  job: string;
  /** fleet.job.v1 state: running, published, archived or unknown. */
  detailState?: string | null;
  lane?: string | null;
  model?: string | null;
  repo?: string | null;
  tier?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  prUrl?: string | null;
  /** The publish record said RESULT EMPTY: the worker had nothing to ship. */
  resultEmpty?: boolean;
  /** The newest applied stop of this attempt. */
  stop?: { at: string | null; by: string | null } | null;
  /** A plain sentence about the job when no state rule applies (e.g. no record here). */
  note?: string | null;
  /** Already-redacted log lines, oldest first. */
  lines?: readonly string[];
  /** Byte offset after the last whole line returned; pass back as `after`. Null when there is no live log. */
  cursor?: number | null;
  /** Earlier lines exist that are not in `lines`. */
  truncated?: boolean;
  /** More new lines are waiting past `cursor` (ask again right away). */
  more?: boolean;
  /** `lines` holds only lines written after the `after` cursor the client sent. */
  since?: number | null;
}

export interface JobWindowFact { label: string; value: string }

export interface FleetJobWindowV1 {
  schema: typeof JOB_WINDOW_SCHEMA;
  job: string;
  state: JobWindowState;
  /** One plain sentence: what state the job is in. */
  stateLine: string;
  /** Why, when known (who stopped it, why nothing shipped); else null. */
  reason: string | null;
  lane: string | null;
  model: string | null;
  repo: string | null;
  tier: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  prUrl: string | null;
  /** The same facts as label/value pairs, "unknown" where there is no evidence. Fixed order. */
  facts: JobWindowFact[];
  log: {
    lines: string[];
    cursor: number | null;
    since: number | null;
    truncated: boolean;
    more: boolean;
    /** Plain words for an empty log; null when there are lines. */
    empty: string | null;
  };
}

export const UNKNOWN = 'unknown';

const clean = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

/** Only http(s) links leave as a PR link. */
export function safeJobPrUrl(value: string | null | undefined): string | null {
  const text = clean(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch { return null; }
}

const validTime = (value: string | null | undefined): string | null => {
  const text = clean(value);
  return text && Number.isFinite(Date.parse(text)) ? text : null;
};

function stateOf(f: JobWindowFacts, prUrl: string | null): { state: JobWindowState; stateLine: string; reason: string | null } {
  const detail = f.detailState ?? null;
  if (detail === 'published' && prUrl) {
    return { state: 'finished-pr', stateLine: 'Finished with a pull request.', reason: null };
  }
  if (f.stop && detail !== 'published') {
    const by = clean(f.stop.by);
    const at = validTime(f.stop.at);
    const reason = `Stopped${by ? ` by ${by}` : ''}${at ? ` at ${at}` : ''}.`;
    return { state: 'stopped', stateLine: 'Stopped before it finished.', reason };
  }
  if (detail === 'published') {
    return {
      state: 'finished-empty', stateLine: 'Finished with nothing to ship.',
      reason: f.resultEmpty ? 'The worker reported no change to publish.' : 'A result was recorded without a pull request link.',
    };
  }
  if (detail === 'archived') {
    return { state: 'finished-empty', stateLine: 'Finished with nothing to ship.', reason: 'The job ended without publishing a result.' };
  }
  if (detail === 'running') return { state: 'running', stateLine: 'Running now.', reason: null };
  return { state: 'unknown', stateLine: 'State unknown.', reason: clean(f.note) };
}

/** The one rule that turns one job's facts into its window. Pure. */
export function buildJobWindow(f: JobWindowFacts): FleetJobWindowV1 {
  const prUrl = safeJobPrUrl(f.prUrl);
  const { state, stateLine, reason } = stateOf(f, prUrl);
  const lane = clean(f.lane);
  const model = clean(f.model);
  const repo = clean(f.repo);
  const tier = clean(f.tier);
  const startedAt = validTime(f.startedAt);
  // Only a finished or stopped job has a finish time; a stale ledger row cannot end a running job.
  const finishedAt = state === 'running' || state === 'unknown' ? null : validTime(f.finishedAt) ?? (state === 'stopped' ? validTime(f.stop?.at) : null);
  const lines = [...(f.lines ?? [])];
  const since = typeof f.since === 'number' && Number.isSafeInteger(f.since) && f.since >= 0 ? f.since : null;
  const cursor = typeof f.cursor === 'number' && Number.isSafeInteger(f.cursor) && f.cursor >= 0 ? f.cursor : null;
  const empty = lines.length > 0 ? null
    : since !== null ? 'No new lines.'
      : state === 'running' ? 'No log lines yet.'
        : state === 'unknown' ? 'No log on this machine.' : 'The log has no lines here.';
  const or = (value: string | null): string => value ?? UNKNOWN;
  return {
    schema: JOB_WINDOW_SCHEMA,
    job: f.job,
    state, stateLine, reason,
    lane, model, repo, tier, startedAt, finishedAt, prUrl,
    facts: [
      { label: 'Lane', value: or(lane) },
      { label: 'Model', value: or(model) },
      { label: 'Repo', value: or(repo) },
      { label: 'Tier', value: or(tier) },
      { label: 'Started', value: or(startedAt) },
      { label: 'Finished', value: state === 'running' ? 'not yet' : or(finishedAt) },
      { label: 'Pull request', value: prUrl ?? (state === 'running' ? 'not yet' : 'none') },
    ],
    log: { lines, cursor, since, truncated: f.truncated === true, more: f.more === true, empty },
  };
}

/** Plain text for a terminal: state, reason, facts, then the log. Shared by `phm job show`. */
export function jobWindowText(w: FleetJobWindowV1): string[] {
  const out = [`Job ${w.job}: ${w.stateLine}`];
  if (w.reason) out.push(w.reason);
  const width = Math.max(...w.facts.map(f => f.label.length));
  for (const fact of w.facts) out.push(`  ${fact.label.padEnd(width)}  ${fact.value}`);
  out.push('');
  if (w.log.truncated) out.push('… earlier lines not shown');
  if (w.log.lines.length === 0 && w.log.empty) out.push(w.log.empty);
  out.push(...w.log.lines);
  return out;
}

/** True when the job can still write new lines worth waiting for. */
export function jobWindowLive(w: Pick<FleetJobWindowV1, 'state'>): boolean {
  return w.state === 'running';
}
