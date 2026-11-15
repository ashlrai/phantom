/**
 * Duty-cycle governor for the dashboard read-projection worker.
 *
 * WHY: the desktop keeps `/api/events` (1.5 s ticks) and several 2-30 s polls
 * open for as long as it runs. Every tick asked the worker for a full
 * rebuild once the caller's 5 s cache lapsed. On a large operator home
 * (164k fleet files, 3 GB of transcripts) one `snapshot` build took ~65-70 s,
 * longer than the worker's 60 s timeout, so the build was killed, the worker
 * respawned, and the next tick started the same doomed build. The installed
 * Verse server burned a full core on that loop (and another on `control`,
 * `fleet-activity`, `pulse`) for days with no client action at all.
 *
 * The governor bounds that work without changing what a projection computes:
 *   - a successful build stays fresh for `costMultiplier` × its own cost, so a
 *     projection that costs D ms uses at most 1/(1+multiplier) of one worker
 *     while it is polled (default ≤10 %), and a cheap one barely caches at all;
 *   - an EXPENSIVE projection (cost ≥ `staleServeMinCostMs`) is served stale
 *     while its next build runs, so no request waits on a rebuild it already
 *     has an answer for;
 *   - a failed or timed-out build backs off before it may run again — by the
 *     same cost multiple, growing exponentially per consecutive failure —
 *     and requests in the meantime get the last good value or a fast
 *     rejection instead of a fresh 60 s build each.
 * `invalidate()` (after an authenticated mutation) drops every cached value
 * and backoff, so the operator's own changes are never hidden.
 */
import { ReadProjectionError } from './bounded-read-worker.js';
import type { ReadProjectionKind, ReadProjectionPayloads, ReadProjectionReader, ReadProjectionResults } from './read-projections.js';

export interface ReadProjectionGovernorOptions {
  /** Monotonic clock in ms. Default `performance.now`. */
  now?: () => number;
  /** Fresh window = multiplier × last build cost. Default 9 (≤10 % duty per projection). */
  costMultiplier?: number;
  /** Upper bound of a fresh window. Default 10 minutes. */
  maxFreshMs?: number;
  /** Builds at least this expensive are served stale while they refresh. Default 1 s. */
  staleServeMinCostMs?: number;
  /** First backoff after a failure; doubles per consecutive failure. Default 15 s. */
  failureBackoffMs?: number;
  /** Backoff ceiling. Default 10 minutes. */
  maxFailureBackoffMs?: number;
  /** Distinct (kind, payload) entries kept; the oldest is dropped beyond it. Default 64. */
  maxEntries?: number;
}

export interface ReadProjectionGovernorStats {
  /** Builds requested from the underlying reader. */
  builds: number;
  /** Reads answered from a fresh value. */
  fresh: number;
  /** Reads answered from a stale value (refresh running or backing off). */
  stale: number;
  /** Reads rejected without a build because the projection is backing off. */
  backoffRejections: number;
}

export interface GovernedReadProjectionReader extends ReadProjectionReader {
  stats(): ReadProjectionGovernorStats;
}

interface Entry {
  hasValue: boolean;
  value: unknown;
  /** Clock time until which `value` is served without a build. */
  freshUntil: number;
  /** Cost of the last successful build, ms. */
  costMs: number;
  /** Clock time before which no new build may start after a failure. */
  retryAt: number;
  failures: number;
  lastErrorCode: string;
  inflight: Promise<unknown> | null;
}

/** Errors that say nothing about the projection's cost: never back off on them. */
const NO_BACKOFF_CODES: ReadonlySet<string> = new Set(['READ_PROJECTION_INVALID_REQUEST', 'READ_PROJECTION_CLOSED']);

function positive(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < 0) throw new RangeError(`Invalid read projection governor option: ${name}`);
  return result;
}

export function governReadProjections(
  inner: ReadProjectionReader,
  options: ReadProjectionGovernorOptions = {},
): GovernedReadProjectionReader {
  const now = options.now ?? (() => performance.now());
  const multiplier = positive(options.costMultiplier, 9, 'costMultiplier');
  const maxFreshMs = positive(options.maxFreshMs, 10 * 60_000, 'maxFreshMs');
  const staleServeMinCostMs = positive(options.staleServeMinCostMs, 1_000, 'staleServeMinCostMs');
  const failureBackoffMs = positive(options.failureBackoffMs, 15_000, 'failureBackoffMs');
  const maxFailureBackoffMs = positive(options.maxFailureBackoffMs, 10 * 60_000, 'maxFailureBackoffMs');
  const maxEntries = Math.max(1, Math.floor(positive(options.maxEntries, 64, 'maxEntries')));
  const entries = new Map<string, Entry>();
  const stats: ReadProjectionGovernorStats = { builds: 0, fresh: 0, stale: 0, backoffRejections: 0 };
  // Bumped by invalidate(): a build started before it must not repopulate.
  let epoch = 0;
  // The worker runs one build at a time, in request order. A build therefore
  // starts EXECUTING when the build queued before it settles; charging it
  // only from then keeps a cheap projection queued behind a slow snapshot
  // from inheriting the snapshot's cost (and a minutes-long fresh window).
  let queueTail: Promise<void> = Promise.resolve();
  let buildsInFlight = 0;

  function entryFor(key: string): Entry {
    let entry = entries.get(key);
    if (entry) {
      // Map order doubles as recency for the bounded eviction below.
      entries.delete(key);
      entries.set(key, entry);
      return entry;
    }
    entry = { hasValue: false, value: undefined, freshUntil: 0, costMs: 0, retryAt: 0, failures: 0, lastErrorCode: '', inflight: null };
    entries.set(key, entry);
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value as string;
      entries.delete(oldest);
    }
    return entry;
  }

  function startBuild<K extends ReadProjectionKind>(entry: Entry, kind: K, payload: ReadProjectionPayloads[K] | undefined): Promise<unknown> {
    let startedAt = now();
    const startedEpoch = epoch;
    stats.builds++;
    if (buildsInFlight > 0) void queueTail.then(() => { startedAt = Math.max(startedAt, now()); });
    buildsInFlight++;
    const build = (payload === undefined ? inner.read(kind) : inner.read(kind, payload)).then((value) => {
      if (startedEpoch === epoch) {
        const finishedAt = now();
        entry.costMs = Math.max(0, finishedAt - startedAt);
        entry.hasValue = true;
        entry.value = value;
        entry.freshUntil = finishedAt + Math.min(maxFreshMs, entry.costMs * multiplier);
        entry.failures = 0;
        entry.retryAt = 0;
      }
      return value;
    }, (error: unknown) => {
      const code = error instanceof ReadProjectionError ? error.code : 'READ_PROJECTION_UNAVAILABLE';
      if (startedEpoch === epoch && !NO_BACKOFF_CODES.has(code)) {
        const failedAt = now();
        entry.failures++;
        entry.lastErrorCode = code;
        // A failed build is held to the same duty rule as a good one (a 60 s
        // timeout waits ≥9 min), plus exponential growth for cheap failures.
        const exponential = failureBackoffMs * 2 ** Math.min(entry.failures - 1, 30);
        const costScaled = Math.max(0, failedAt - startedAt) * multiplier;
        entry.retryAt = failedAt + Math.min(maxFailureBackoffMs, Math.max(exponential, costScaled));
      }
      throw error;
    }).finally(() => {
      buildsInFlight--;
      if (entry.inflight === build) entry.inflight = null;
    });
    entry.inflight = build;
    queueTail = build.then(() => undefined, () => undefined);
    return build;
  }

  function read<K extends ReadProjectionKind>(kind: K, payload?: ReadProjectionPayloads[K]): Promise<ReadProjectionResults[K]> {
    let key: string;
    try { key = `${kind}:${JSON.stringify(payload ?? null)}`; }
    catch { return inner.read(kind, payload); }
    const entry = entryFor(key);
    const at = now();
    if (entry.hasValue && at < entry.freshUntil) {
      stats.fresh++;
      return Promise.resolve(entry.value as ReadProjectionResults[K]);
    }
    const serveStale = entry.hasValue && (entry.costMs >= staleServeMinCostMs || entry.failures > 0);
    if (entry.inflight) {
      if (serveStale) { stats.stale++; return Promise.resolve(entry.value as ReadProjectionResults[K]); }
      return entry.inflight as Promise<ReadProjectionResults[K]>;
    }
    if (at < entry.retryAt) {
      if (entry.hasValue) { stats.stale++; return Promise.resolve(entry.value as ReadProjectionResults[K]); }
      stats.backoffRejections++;
      return Promise.reject(new ReadProjectionError('Read projection is backing off after a failed build', entry.lastErrorCode || 'READ_PROJECTION_UNAVAILABLE'));
    }
    const build = startBuild(entry, kind, payload);
    if (serveStale) {
      // The caller has an answer now; the refresh's own failure is recorded above.
      build.catch(() => {});
      stats.stale++;
      return Promise.resolve(entry.value as ReadProjectionResults[K]);
    }
    return build as Promise<ReadProjectionResults[K]>;
  }

  return {
    read,
    invalidate: () => {
      epoch++;
      entries.clear();
      return inner.invalidate();
    },
    close: () => {
      epoch++;
      entries.clear();
      return inner.close();
    },
    stats: () => ({ ...stats }),
  };
}
