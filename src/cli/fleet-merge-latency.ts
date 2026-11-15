/**
 * Read-only merge latency: how long PRs wait for the queue and for the merge,
 * and which conflicts the recut automation can safely retry. Dropped
 * auto-merges classify under queue_retries for `phm fleet merge-retry`.
 * Advisory only: nothing here merges, requeues or skips a required check.
 */
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { recutRequest, type MergeRecutRequest } from '../core/merge-eta.js';

const usage = 'Usage: ashlr fleet merge-latency [--events <file>] [--hours <n>] [--stalled-after <seconds>] [--json]';
const SCHEMA = 'fleet.merge-latency.v1';
const DEFAULT_HOURS = 24;
const MAX_HOURS = 24 * 30;
const MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_STALLED_AFTER = 3600;
/** After this many recut requests for one PR, a person should look at it. */
const MAX_RECUTS = 3;
/** After this many auto-merge retries for one PR, a person should look at it. */
export const MAX_QUEUE_RETRIES = 3;

export type MergeEventType = 'opened' | 'queued' | 'checks_passed' | 'conflict' | 'recut_requested' | 'retry_requested' | 'retry_failed' | 'merged' | 'closed' | 'auto_merge_enabled' | 'auto_merge_disabled' | 'eligible' | 'blocked' | 'check_observed';
const TYPES: ReadonlySet<string> = new Set<MergeEventType>(['opened', 'queued', 'checks_passed', 'conflict', 'recut_requested', 'retry_requested', 'retry_failed', 'merged', 'closed', 'auto_merge_enabled', 'auto_merge_disabled', 'eligible', 'blocked', 'check_observed']);

/** One JSON object per line. `head_sha` is read from conflict and recut_requested events. */
export interface MergeEvent { repo: string; pr: number; type: MergeEventType; at?: string; head_sha?: string; reason?: BlockerReason; required?: boolean; conclusion?: 'success' | 'failure' | 'pending' }
export type BlockerReason = 'required_checks' | 'review' | 'conflict' | 'queue' | 'other';
const BLOCKER_REASONS: readonly BlockerReason[] = ['required_checks', 'review', 'conflict', 'queue', 'other'];
const eventTime = (e: MergeEvent): number => Date.parse(e.at ?? '');

export interface PendingAutoMerge {
  repo: string; pr: number; auto_merge: 'enabled' | 'unknown'; waiting_s: number | null; stalled: boolean | null;
}

/**
 * An open PR whose recorded auto-merge request was dropped by a transient
 * queue failure — the last recorded blocker in the enable→disable episode is
 * `queue` — and which is inside the retry bound. Observations only; the retry
 * itself is `phm fleet merge-retry` re-arming ordinary auto-merge.
 */
export interface RetryableQueueFailure {
  repo: string; pr: number;
  /** When the dropped auto-merge was observed. */
  disabled_at: string;
  waiting_s: number;
  /** Newest head carried by any event for this PR; null when none was recorded. */
  head_sha: string | null;
  /** Distinct retry_requested events recorded for this PR (deduplicated). */
  retries_used: number;
  retries_left: number;
  /** Distinct retry_failed submission events recorded for this PR (deduplicated). */
  requests_failed: number;
}
export type QueueRetryBlockReason = 'unattributed' | 'already-requested' | 'too-many-retries' | 'request-failed';
export interface BlockedQueueRetry { repo: string; pr: number; reason: QueueRetryBlockReason; retries_used: number; requests_failed: number }
export interface QueueRetries {
  /** Transient queue failures `phm fleet merge-retry` may re-arm, longest wait first. */
  retryable: RetryableQueueFailure[];
  /** Dropped auto-merges that are not safe to re-arm automatically. */
  needs_person: BlockedQueueRetry[];
}

/** Returns the raw events text, or null when unreadable. */
export type MergeEventReader = () => Promise<string | null>;

export interface LatencyStats { count: number; missing: number; p50_s: number | null; p90_s: number | null; max_s: number | null }
export interface RetryableConflict { repo: string; pr: number; head_sha: string; waiting_s: number; recut: MergeRecutRequest }
export interface BlockedConflict { repo: string; pr: number; reason: 'no-head' | 'already-requested' | 'too-many-recuts' }

export interface MergeLatencyReport {
  schema: typeof SCHEMA;
  known: boolean;
  window_hours: number;
  merged: number;
  merged_time_unknown: number;
  /** PRs still open in the supplied ledger, across all ages. */
  open: number;
  ignored_events: number;
  /** Seconds from opening to joining the merge queue. */
  opened_to_queue: LatencyStats | null;
  /** Seconds from joining the merge queue to merged (required checks run inside this time). */
  queue_to_merge: LatencyStats | null;
  /** Seconds from opening to merged. */
  total: LatencyStats | null;
  /** The step with the larger median, in plain words. */
  slowest_step: 'opened_to_queue' | 'queue_to_merge' | null;
  retryable_conflicts: RetryableConflict[] | null;
  blocked_conflicts: BlockedConflict[] | null;
  stalled_after_s: number;
  /** All pending auto-merges, including old PRs and unknown enable times. Never merge authority. */
  pending_auto_merge: PendingAutoMerge[] | null;
  /** Open PRs whose recorded auto-merge was dropped, split by retry safety. Never merge authority. */
  queue_retries: QueueRetries | null;
  queue_timelines: QueueTimeline[] | null;
  /** Aggregate seconds PRs spent in each queue state across all timelines. */
  queue_state_time: QueueStateTime | null;
  pr_stages: PrStages[] | null;
}

/**
 * Fleet-level rollup of the per-PR queue timeline spans: how much time PRs
 * spent queued before eligibility, eligible before merge, still waiting now,
 * and blocked on each recorded reason. Each stat is a `LatencyStats` over one
 * value per timeline; a PR whose span is unmeasurable counts `missing`, never
 * zero. In a measurable wait-by-reason breakdown an absent reason is a
 * measured zero (no time was spent blocked on it).
 */
export interface QueueStateTime {
  /** Per-PR enqueue→eligible seconds. */
  enqueue_to_eligible: LatencyStats;
  /** Per-PR eligible→merge seconds. */
  eligible_to_merge: LatencyStats;
  /** Per-PR current dwell for still-queued open PRs. */
  open_dwell: LatencyStats;
  /** Per-PR seconds blocked on each reason. */
  blocked: Record<BlockerReason, LatencyStats>;
}

export type PrStage = 'queue_wait' | 'required_checks' | 'merge';
export interface PrStages {
  repo: string; pr: number;
  queue_wait_s: number | null; required_checks_s: number | null; merge_s: number | null;
  missing_or_ambiguous: MergeEventType[];
  out_of_order: boolean;
  slowest_stage: PrStage | null;
}

function prStages(events: MergeEvent[]): PrStages {
  const boundaries = ['opened', 'queued', 'checks_passed', 'merged'] as const;
  const times = boundaries.map(type => {
    const matches = events.filter(e => e.type === type);
    return matches.length === 1 && matches[0]!.at ? eventTime(matches[0]!) : undefined;
  });
  const durations = [gap(times[0], times[1]), gap(times[1], times[2]), gap(times[2], times[3])];
  // A later retry or reversed boundary cannot establish a single stage breakdown.
  const ordered = times.every((time, i) => i === 0 || time === undefined || times[i - 1] === undefined || time >= times[i - 1]!);
  const complete = ordered && durations.every(d => d !== null);
  const names: PrStage[] = ['queue_wait', 'required_checks', 'merge'];
  const max = complete ? Math.max(...durations as number[]) : null;
  // Ties have no unique slowest stage.
  const winners = max === null ? [] : names.filter((_, i) => durations[i] === max);
  return { repo: events[0]!.repo, pr: events[0]!.pr,
    queue_wait_s: durations[0]!, required_checks_s: durations[1]!, merge_s: durations[2]!,
    missing_or_ambiguous: boundaries.filter((_, i) => times[i] === undefined),
    out_of_order: !ordered,
    slowest_stage: winners.length === 1 ? winners[0]! : null };
}

/** Recorded transitions are observations, not permission to merge. */
export interface QueueTimeline {
  repo: string; pr: number; enqueued_at: string | null; eligible_at: string | null; merged_at: string | null;
  blocked: { at: string; reason: BlockerReason }[];
  enqueue_to_eligible_s: number | null; eligible_to_merge_s: number | null;
  /** Current queue dwell for an open PR with exactly one timed enqueue. */
  current_dwell_s: number | null;
  wait_by_reason_s: Partial<Record<BlockerReason, number>> | null;
  checks: { required_failures: number; unrelated_failures: number; unknown_failures: number } | null;
}

type QueueRetryVerdict = { kind: 'none' } | { kind: 'retryable'; row: RetryableQueueFailure } | { kind: 'blocked'; row: BlockedQueueRetry };

/**
 * Classify one open PR's queue-failure state. A transient queue failure is an
 * observed auto-merge drop — the latest timed toggle is `auto_merge_disabled`
 * after a timed `auto_merge_enabled` — whose newest recorded blocker in the
 * episode is `queue`. A disable with no queue blocker is `unattributed` (it
 * may be a deliberate disable; a person decides); one attributed to
 * `conflict`, `required_checks`, `review` or `other` is not reported here —
 * the conflict path owns conflicts and people own the rest. An untimed toggle
 * beside a timed disable leaves the armed state unknown and also lands in
 * `unattributed`. An identical `retry_requested` line replayed into the
 * ledger counts once; a retry requested at or after this disable is
 * `already-requested`, and MAX_QUEUE_RETRIES distinct requests exhaust the
 * bound. `retry_failed` lines (a submitted re-arm that failed) dedupe the
 * same way and share the bound separately: they never mark the episode
 * already-requested, but MAX_QUEUE_RETRIES distinct failed submissions make
 * the failure permanent — `request-failed` — so automation stops retrying it.
 */
function queueRetryVerdict(events: MergeEvent[], now: number): QueueRetryVerdict {
  const isTimed = (e: MergeEvent) => e.at !== undefined && Number.isFinite(eventTime(e));
  const toggles = events.filter(e => isTimed(e) && (e.type === 'auto_merge_enabled' || e.type === 'auto_merge_disabled'));
  const last = toggles[toggles.length - 1];
  if (last?.type !== 'auto_merge_disabled') return { kind: 'none' };
  const disabledAt = eventTime(last);
  const { repo, pr } = last;
  const dedupe = (list: MergeEvent[]) => new Set(list.map(e => `${e.at ?? ''}|${(e.head_sha ?? '').toLowerCase()}`)).size;
  const retries = events.filter(e => e.type === 'retry_requested');
  const retriesUsed = dedupe(retries);
  const requestsFailed = dedupe(events.filter(e => e.type === 'retry_failed'));
  const blocked = (reason: QueueRetryBlockReason): QueueRetryVerdict =>
    ({ kind: 'blocked', row: { repo, pr, reason, retries_used: retriesUsed, requests_failed: requestsFailed } });
  // An untimed toggle leaves the armed state unknown; a person decides.
  if (events.some(e => !isTimed(e) && (e.type === 'auto_merge_enabled' || e.type === 'auto_merge_disabled'))) return blocked('unattributed');
  if (retries.some(e => isTimed(e) && eventTime(e) >= disabledAt)) return blocked('already-requested');
  const enables = toggles.filter(e => e.type === 'auto_merge_enabled' && eventTime(e) < disabledAt);
  if (enables.length === 0) return blocked('unattributed');
  const enabledAt = eventTime(enables[enables.length - 1]!);
  const lastBlocked = events.filter(e => isTimed(e) && e.type === 'blocked' && eventTime(e) > enabledAt).at(-1);
  if (lastBlocked === undefined) return blocked('unattributed');
  if (lastBlocked.reason !== 'queue') return { kind: 'none' };
  if (retriesUsed >= MAX_QUEUE_RETRIES) return blocked('too-many-retries');
  if (requestsFailed >= MAX_QUEUE_RETRIES) return blocked('request-failed');
  let head: string | null = null;
  for (const e of events) if (e.head_sha) head = e.head_sha;
  return { kind: 'retryable', row: { repo, pr, disabled_at: last.at!, head_sha: head,
    waiting_s: Math.max(0, Math.round((now - disabledAt) / 1000)), retries_used: retriesUsed,
    retries_left: MAX_QUEUE_RETRIES - retriesUsed, requests_failed: requestsFailed } };
}

function timeline(events: MergeEvent[], now: number): QueueTimeline {
  const one = (type: MergeEventType) => {
    const matches = events.filter(e => e.type === type);
    return matches.length === 1 && matches[0]!.at ? matches[0]!.at! : null;
  };
  const enqueued_at = one('queued'), eligible_at = one('eligible'), merged_at = one('merged');
  const blocked = events.filter(e => e.type === 'blocked' && e.at && e.reason)
    .map(e => ({ at: e.at!, reason: e.reason! }));
  // Reblocking after eligibility makes a single eligibility boundary ambiguous.
  const valid = enqueued_at && eligible_at && merged_at && Date.parse(enqueued_at) <= Date.parse(eligible_at)
    && Date.parse(eligible_at) <= Date.parse(merged_at)
    && blocked.every(b => Date.parse(b.at) >= Date.parse(enqueued_at) && Date.parse(b.at) < Date.parse(eligible_at));
  // A blocker starts an interval and the next blocker or eligibility ends it.
  // Without an observation at enqueue, the preceding time has no known reason.
  const wait: Partial<Record<BlockerReason, number>> = {};
  const transitions = events.filter(e => e.type === 'blocked' || e.type === 'eligible');
  const measurable = enqueued_at && eligible_at && Date.parse(enqueued_at) <= Date.parse(eligible_at)
    && blocked.every(b => Date.parse(b.at) >= Date.parse(enqueued_at) && Date.parse(b.at) < Date.parse(eligible_at))
    && events.filter(e => e.type === 'eligible').length === 1 && blocked.length > 0 && Date.parse(blocked[0]!.at) === Date.parse(enqueued_at)
    && transitions.every((e, i) => i === 0 || eventTime(e) > eventTime(transitions[i - 1]!));
  if (measurable) for (let i = 0; i < transitions.length - 1; i++) {
    const e = transitions[i]!;
    if (e.type === 'blocked' && e.reason) wait[e.reason] = (wait[e.reason] ?? 0) + (eventTime(transitions[i + 1]!) - eventTime(e)) / 1000;
  }
  const failures = events.filter(e => e.type === 'check_observed' && e.conclusion === 'failure');
  const checks = events.some(e => e.type === 'check_observed') ? { required_failures: failures.filter(e => e.required === true).length,
    unrelated_failures: failures.filter(e => e.required === false).length,
    unknown_failures: failures.filter(e => e.required === undefined).length } : null;
  return { repo: events[0]!.repo, pr: events[0]!.pr, enqueued_at, eligible_at, merged_at, blocked,
    wait_by_reason_s: measurable ? wait : null, checks,
    current_dwell_s: enqueued_at && !events.some(e => e.type === 'merged' || e.type === 'closed')
      ? gap(Date.parse(enqueued_at), now) : null,
    enqueue_to_eligible_s: valid ? gap(Date.parse(enqueued_at!), Date.parse(eligible_at!)) : null,
    eligible_to_merge_s: valid ? gap(Date.parse(eligible_at!), Date.parse(merged_at!)) : null };
}

/** Append one validated observation; never runs a merge or changes checks. */
export async function recordMergeEvent(path: string, value: unknown): Promise<void> {
  const event = parseEvent(JSON.stringify(value));
  if (!event || !event.at || !['opened', 'queued', 'checks_passed', 'eligible', 'blocked', 'merged', 'check_observed', 'retry_requested', 'retry_failed'].includes(event.type)) throw new Error('Invalid merge observation');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

/** Nearest-rank percentile of an ascending list. */
function percentile(sorted: number[], p: number): number {
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

function stats(values: (number | null)[]): LatencyStats {
  const known = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  return { count: known.length, missing: values.length - known.length,
    p50_s: known.length ? percentile(known, 50) : null, p90_s: known.length ? percentile(known, 90) : null,
    max_s: known.length ? known[known.length - 1]! : null };
}

function parseEvent(line: string): MergeEvent | null {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(r.repo) || !Number.isSafeInteger(r.pr) || (r.pr as number) < 1 ||
      typeof r.type !== 'string' || !TYPES.has(r.type)) return null;
  if (r.type === 'blocked' && (typeof r.reason !== 'string' || !BLOCKER_REASONS.includes(r.reason as BlockerReason))) return null;
  if (r.type === 'check_observed' && (!['success', 'failure', 'pending'].includes(String(r.conclusion)) ||
      (r.required !== undefined && typeof r.required !== 'boolean'))) return null;
  const at = typeof r.at === 'string' && Number.isFinite(Date.parse(r.at)) ? r.at : undefined;
  // Preserve state evidence with unknown timing; never invent an enable or merge time.
  if (!at && !['auto_merge_enabled', 'auto_merge_disabled', 'merged', 'closed'].includes(r.type)) return null;
  return { repo: r.repo.toLowerCase(), pr: r.pr as number, type: r.type as MergeEventType, at,
    ...(typeof r.head_sha === 'string' ? { head_sha: r.head_sha } : {}),
    ...(r.type === 'blocked' ? { reason: r.reason as BlockerReason } : {}),
    ...(r.type === 'check_observed' ? { conclusion: r.conclusion as MergeEvent['conclusion'],
      ...(typeof r.required === 'boolean' ? { required: r.required } : {}) } : {}) };
}

const gap = (from: number | undefined, to: number | undefined): number | null =>
  from === undefined || to === undefined || to < from ? null : Math.round((to - from) / 1000);

export async function fleetMergeLatency(read: MergeEventReader, now = Date.now(), hours = DEFAULT_HOURS, stalledAfter = DEFAULT_STALLED_AFTER): Promise<MergeLatencyReport> {
  const base = { schema: SCHEMA, window_hours: hours, stalled_after_s: stalledAfter } as const;
  let text: string | null;
  try { text = await read(); } catch { text = null; }
  if (text === null) {
    return { ...base, known: false, merged: 0, merged_time_unknown: 0, open: 0, ignored_events: 0, opened_to_queue: null, queue_to_merge: null,
      total: null, slowest_step: null, retryable_conflicts: null, blocked_conflicts: null, pending_auto_merge: null, queue_retries: null, queue_timelines: null, queue_state_time: null, pr_stages: null };
  }
  const since = now - hours * 3_600_000;
  const byPr = new Map<string, MergeEvent[]>();
  let ignored = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const event = parseEvent(line);
    if (!event || eventTime(event) > now) { ignored++; continue; }
    const key = `${event.repo}#${event.pr}`;
    byPr.set(key, [...(byPr.get(key) ?? []), event]);
  }
  const toQueue: (number | null)[] = [];
  const toMerge: (number | null)[] = [];
  const total: (number | null)[] = [];
  const retryable: RetryableConflict[] = [];
  const blocked: BlockedConflict[] = [];
  const retryableQueueFailures: RetryableQueueFailure[] = [];
  const blockedQueueRetries: BlockedQueueRetry[] = [];
  const pending: PendingAutoMerge[] = [];
  const timelines: QueueTimeline[] = [];
  const stages: PrStages[] = [];
  let merged = 0;
  let mergedTimeUnknown = 0;
  let open = 0;
  for (const events of byPr.values()) {
    // Stable sort: events sharing a timestamp keep their file order.
    events.sort((a, b) => (a.at ? eventTime(a) : -Infinity) - (b.at ? eventTime(b) : -Infinity));
    const last = events[events.length - 1]!;
    const first = (type: MergeEventType) => { const e = events.find(x => x.type === type); return e?.at ? eventTime(e) : undefined; };
    const { repo, pr } = last;
    const mergedAt = first('merged');
    if (mergedAt === undefined || mergedAt >= since) stages.push(prStages(events));
    if (events.some(e => e.type === 'queued' || e.type === 'eligible' || e.type === 'blocked' || e.type === 'check_observed')) timelines.push(timeline(events, now));
    if (events.some(e => e.type === 'merged')) {
      if (mergedAt !== undefined && mergedAt < since) continue;
      merged++;
      if (mergedAt === undefined) mergedTimeUnknown++;
      toQueue.push(gap(first('opened'), first('queued')));
      toMerge.push(gap(first('queued'), mergedAt));
      total.push(gap(first('opened'), mergedAt));
      continue;
    }
    if (events.some(e => e.type === 'closed')) continue;
    open++;
    const toggles = events.filter(e => e.type === 'auto_merge_enabled' || e.type === 'auto_merge_disabled');
    const latest = toggles.at(-1);
    // Untimed or simultaneous contradictory toggles cannot establish current state.
    const unknown = toggles.some(e => !e.at || (latest && eventTime(e) === eventTime(latest) && e.type !== latest.type));
    if (latest && (unknown ? toggles.some(e => e.type === 'auto_merge_enabled') : latest.type === 'auto_merge_enabled')) {
      const waiting = unknown ? null : Math.floor((now - eventTime(latest)) / 1000);
      pending.push({ repo, pr, auto_merge: unknown && toggles.some(e => e.type === 'auto_merge_disabled') ? 'unknown' : 'enabled',
        waiting_s: waiting, stalled: waiting === null ? null : waiting >= stalledAfter });
    }
    // Dropped auto-merges stay visible at every age, like pending auto-merges.
    const verdict = queueRetryVerdict(events, now);
    if (verdict.kind === 'retryable') retryableQueueFailures.push(verdict.row);
    else if (verdict.kind === 'blocked') blockedQueueRetries.push(verdict.row);
    // Current pending PRs never age out; the window limits historical metrics and recut advice.
    if (eventTime(last) < since) continue;
    // A conflict stays current until the PR is queued or its checks pass again on a new head.
    let conflict = -1;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]!.type === 'conflict') { conflict = i; break; }
      if (events[i]!.type === 'queued' || events[i]!.type === 'checks_passed') break;
    }
    if (conflict < 0) continue;
    const head = events[conflict]!.head_sha ?? null;
    const request = recutRequest(repo, pr, head);
    const asked = events.filter(e => e.type === 'recut_requested');
    if (!request) blocked.push({ repo, pr, reason: 'no-head' });
    else if (asked.length >= MAX_RECUTS) blocked.push({ repo, pr, reason: 'too-many-recuts' });
    else if (asked.some(e => eventTime(e) >= eventTime(events[conflict]!) && (!e.head_sha || e.head_sha.toLowerCase().startsWith(request.headSha.slice(0, 7))))) {
      blocked.push({ repo, pr, reason: 'already-requested' });
    } else retryable.push({ repo, pr, head_sha: request.headSha, waiting_s: Math.max(0, Math.round((now - eventTime(events[conflict]!)) / 1000)), recut: request });
  }
  const byWait = (a: { waiting_s: number }, b: { waiting_s: number }) => b.waiting_s - a.waiting_s;
  const byPrId = (a: { repo: string; pr: number }, b: { repo: string; pr: number }) => a.repo.localeCompare(b.repo) || a.pr - b.pr;
  const q = stats(toQueue);
  const m = stats(toMerge);
  const stateTime: QueueStateTime = {
    enqueue_to_eligible: stats(timelines.map(t => t.enqueue_to_eligible_s)),
    eligible_to_merge: stats(timelines.map(t => t.eligible_to_merge_s)),
    open_dwell: stats(timelines.map(t => t.current_dwell_s)),
    blocked: Object.fromEntries(BLOCKER_REASONS.map(reason =>
      [reason, stats(timelines.map(t => t.wait_by_reason_s === null ? null : t.wait_by_reason_s[reason] ?? 0))])) as Record<BlockerReason, LatencyStats>,
  };
  return { ...base, known: true, merged, merged_time_unknown: mergedTimeUnknown, open, ignored_events: ignored, opened_to_queue: q, queue_to_merge: m, total: stats(total),
    slowest_step: q.p50_s === null || m.p50_s === null ? null : m.p50_s >= q.p50_s ? 'queue_to_merge' : 'opened_to_queue',
    retryable_conflicts: retryable.sort(byWait), blocked_conflicts: blocked.sort(byPrId),
    queue_retries: { retryable: retryableQueueFailures.sort((a, b) => b.waiting_s - a.waiting_s || byPrId(a, b)), needs_person: blockedQueueRetries.sort(byPrId) },
    queue_timelines: timelines.sort(byPrId), queue_state_time: stateTime, pr_stages: stages.sort(byPrId), pending_auto_merge: pending.sort((a, b) => (b.waiting_s ?? -1) - (a.waiting_s ?? -1) || byPrId(a, b)) };
}

export const readMergeEvents = (path: string): MergeEventReader => async () => {
  try {
    const info = await stat(path);
    return info.isFile() && info.size <= MAX_BYTES ? await readFile(path, 'utf8') : null;
  } catch { return null; }
};

const secs = (v: number | null): string => v === null ? 'unknown' : `${v}s`;
const line = (name: string, s: LatencyStats | null): string =>
  `${name}: median ${secs(s?.p50_s ?? null)}, 90th percentile ${secs(s?.p90_s ?? null)}, slowest ${secs(s?.max_s ?? null)} (${s?.count ?? 0} measured, ${s?.missing ?? 0} missing events)`;

/** One compact line summarizing measured time in each queue state. */
function stateTimeLine(t: QueueStateTime): string {
  const part = (label: string, s: LatencyStats): string | null => s.count === 0 ? null
    : `${label} median ${secs(s.p50_s)} across ${s.count} PR${s.count === 1 ? '' : 's'}${s.missing ? ` (${s.missing} unmeasured)` : ''}`;
  const parts = [
    part('queued', t.enqueue_to_eligible),
    part('eligible', t.eligible_to_merge),
    part('still queued', t.open_dwell),
    ...BLOCKER_REASONS.map(reason => part(`blocked on ${reason.replace('_', ' ')}`, t.blocked[reason])),
  ].filter((p): p is string => p !== null);
  return parts.length ? `Time in each queue state: ${parts.join('; ')}.` : 'Time in each queue state: unknown (no measured spans).';
}

function pendingLine(p: PendingAutoMerge): string {
  const state = p.auto_merge === 'unknown' ? 'auto-merge state unknown'
    : p.stalled === null ? 'auto-merge wait unknown (missing timestamp)'
    : `${p.stalled ? 'stalled' : 'pending'} auto-merge, ${p.waiting_s}s waiting`;
  return `${p.repo}#${p.pr}: ${state}. Inspect required checks, reviews and queue state; keep required checks in place.`;
}

export function formatMergeLatency(r: MergeLatencyReport): string {
  if (!r.known) return 'Merge latency: unknown (events unreadable)';
  const retry = r.retryable_conflicts!;
  return [
    `Last ${r.window_hours} hours: ${r.merged - r.merged_time_unknown} merged; ${r.merged_time_unknown} merged at an unknown time. Still open in ledger (all ages): ${r.open}.`,
    line('Waiting to join the queue', r.opened_to_queue),
    line('Queue to merge', r.queue_to_merge),
    ...r.pr_stages!.map(p => `${p.repo}#${p.pr}: queue wait ${secs(p.queue_wait_s)}, required checks ${secs(p.required_checks_s)}, merge ${secs(p.merge_s)}; slowest stage: ${p.slowest_stage ?? 'unknown (incomplete, unordered, or tied)'}; missing or ambiguous: ${p.missing_or_ambiguous.join(', ') || 'none'}${p.out_of_order ? '; timestamps out of order' : ''}.`),
    ...r.queue_timelines!.map(t => `${t.repo}#${t.pr}: enqueue to eligible ${secs(t.enqueue_to_eligible_s)}, eligible to merge ${secs(t.eligible_to_merge_s)}; blockers: ${t.blocked.map(b => b.reason).join(', ') || 'none recorded'}; wait by reason: ${t.wait_by_reason_s === null ? 'unknown' : Object.entries(t.wait_by_reason_s).map(([reason, seconds]) => `${reason} ${seconds}s`).join(', ')}; failed observations: ${t.checks ? `${t.checks.required_failures} required, ${t.checks.unrelated_failures} unrelated, ${t.checks.unknown_failures} unknown` : 'unknown'}.`),
    stateTimeLine(r.queue_state_time!),
    line('Open to merge', r.total),
    `Pending auto-merge: ${r.pending_auto_merge!.length} (${r.pending_auto_merge!.filter(p => p.stalled).length} stalled after ${r.stalled_after_s}s, ${r.pending_auto_merge!.filter(p => p.stalled === null).length} unknown waits).`,
    ...r.pending_auto_merge!.map(pendingLine),
    r.slowest_step ? `Slowest step: ${r.slowest_step === 'queue_to_merge' ? 'queue to merge' : 'waiting to join the queue'}.` : 'Slowest step: unknown.',
    retry.length ? `Conflicts the recut loop can retry: ${retry.map(c => `#${c.pr} (${c.recut.key})`).join(', ')}` : 'Conflicts the recut loop can retry: none',
    ...r.blocked_conflicts!.map(c => `Needs a person: #${c.pr} (${c.reason})`),
    r.queue_retries!.retryable.length
      ? `Dropped auto-merges merge-retry can re-arm (run phm fleet merge-retry): ${r.queue_retries!.retryable.map(f => `#${f.pr} (${f.retries_left} retries left${f.requests_failed ? `, ${f.requests_failed} failed submission${f.requests_failed === 1 ? '' : 's'}` : ''}, ${f.waiting_s}s dropped)`).join(', ')}`
      : 'Dropped auto-merges merge-retry can re-arm: none',
    ...r.queue_retries!.needs_person.map(f => `Needs a person: #${f.pr} (auto-merge dropped, ${f.reason})`),
    ...(r.ignored_events ? [`${r.ignored_events} unreadable events skipped.`] : []),
  ].join('\n');
}

export interface MergeLatencyDeps { read?: MergeEventReader; now?: number }

export async function cmdFleetMergeLatency(args: string[], deps: MergeLatencyDeps = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log([
      usage,
      'Show first-enqueue-to-merge median and 90th percentile, pending auto-merges and retryable conflicts.',
      'Read-only: required checks are never skipped. No live GitHub query; results reflect the supplied ledger.',
      'Example: phm fleet merge-latency --events merge-events.jsonl --json',
      'Default ledger: ~/.ashlr-runs/metrics/merge-events.jsonl. One JSON event per line: repo, pr, type, at (ISO timestamp), head_sha (optional).',
      'Record: phm fleet merge-latency --events <file> --record <JSON> (repo, pr, type, at; blocked also needs reason).',
      'Recording types: opened, queued, checks_passed, eligible, blocked, merged, check_observed, retry_requested, retry_failed. Blocker reasons: required_checks, review, conflict, queue, other.',
      'Per PR: queue wait is opened to queued; required checks are queued to checks_passed; merge is checks_passed to merged.',
      'Check observations require conclusion (success, failure, pending); required is true, false, or omitted if unknown.',
      'Eligibility is an observed transition; missing, repeated or reblocked boundaries remain unknown. Required checks remain in place.',
      'Types: opened, queued, eligible, blocked, check_observed, checks_passed, conflict, recut_requested, retry_requested, retry_failed, merged, closed, auto_merge_enabled, auto_merge_disabled.',
      'Merged window: --hours (default 24). Missing merge times count as missing samples, separately from dated merges.',
      'Open PRs and pending auto-merges include all ages. Enable/disable events describe transitions; queued alone does not imply auto-merge.',
      'Dropped auto-merges list under queue_retries: retryable needs a queue blocker in the enable-to-disable episode and retries left; phm fleet merge-retry re-arms them with ordinary auto-merge. Three distinct failed submissions (retry_failed) mark a drop request-failed and stop automatic retries.',
      'Stall age starts at the latest enable transition; --stalled-after defaults to 3600 seconds. Missing or conflicting state times stay unknown.',
      'Inspect required checks, reviews and queue state for stalled PRs. Missing events are counted, not guessed. Unreadable events are unknown.',
    ].join('\n'));
    return 0;
  }
  let path = join(homedir(), '.ashlr-runs', 'metrics', 'merge-events.jsonl');
  let hours = DEFAULT_HOURS;
  let json = false;
  let record: string | undefined;
  let stalledAfter = DEFAULT_STALLED_AFTER;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) { console.error(`error: duplicate option\n${usage}`); return 2; }
    seen.add(arg);
    if (arg === '--json') json = true;
    else if (arg === '--record' && args[i + 1]) record = args[++i]!;
    else if (arg === '--events' && args[i + 1] && !args[i + 1]!.startsWith('-')) path = args[++i]!;
    else if (arg === '--stalled-after' && /^[1-9]\d{0,7}$/.test(args[i + 1] ?? '')) stalledAfter = Number(args[++i]);
    else if (arg === '--hours' && /^[1-9]\d{0,3}$/.test(args[i + 1] ?? '') && Number(args[i + 1]) <= MAX_HOURS) hours = Number(args[++i]);
    else { console.error(`error: invalid fleet merge-latency arguments\n${usage}`); return 2; }
  }
  if (record !== undefined) {
    try { await recordMergeEvent(path, JSON.parse(record)); }
    catch { console.error('error: unable to record valid merge observation'); return 1; }
    console.log(json ? JSON.stringify({ recorded: true }) : 'Merge observation recorded.');
    return 0;
  }
  const report = await fleetMergeLatency(deps.read ?? readMergeEvents(path), deps.now ?? Date.now(), hours, stalledAfter);
  console.log(json ? JSON.stringify(report) : formatMergeLatency(report));
  return 0;
}
