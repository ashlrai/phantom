/**
 * Read-only merge latency: how long PRs wait for the queue and for the merge,
 * and which conflicts the recut automation can safely retry. Advisory only:
 * nothing here merges, requeues or skips a required check.
 */
import { readFile, stat } from 'node:fs/promises';
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

export type MergeEventType = 'opened' | 'queued' | 'checks_passed' | 'conflict' | 'recut_requested' | 'merged' | 'closed' | 'auto_merge_enabled' | 'auto_merge_disabled';
const TYPES: ReadonlySet<string> = new Set<MergeEventType>(['opened', 'queued', 'checks_passed', 'conflict', 'recut_requested', 'merged', 'closed', 'auto_merge_enabled', 'auto_merge_disabled']);

/** One JSON object per line. `head_sha` is read from conflict and recut_requested events. */
export interface MergeEvent { repo: string; pr: number; type: MergeEventType; at?: string; head_sha?: string }
const eventTime = (e: MergeEvent): number => Date.parse(e.at ?? '');

export interface PendingAutoMerge {
  repo: string; pr: number; auto_merge: 'enabled' | 'unknown'; waiting_s: number | null; stalled: boolean | null;
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
  const at = typeof r.at === 'string' && Number.isFinite(Date.parse(r.at)) ? r.at : undefined;
  // Preserve state evidence with unknown timing; never invent an enable or merge time.
  if (!at && !['auto_merge_enabled', 'auto_merge_disabled', 'merged', 'closed'].includes(r.type)) return null;
  return { repo: r.repo.toLowerCase(), pr: r.pr as number, type: r.type as MergeEventType, at,
    ...(typeof r.head_sha === 'string' ? { head_sha: r.head_sha } : {}) };
}

const gap = (from: number | undefined, to: number | undefined): number | null =>
  from === undefined || to === undefined || to < from ? null : Math.round((to - from) / 1000);

export async function fleetMergeLatency(read: MergeEventReader, now = Date.now(), hours = DEFAULT_HOURS, stalledAfter = DEFAULT_STALLED_AFTER): Promise<MergeLatencyReport> {
  const base = { schema: SCHEMA, window_hours: hours, stalled_after_s: stalledAfter } as const;
  let text: string | null;
  try { text = await read(); } catch { text = null; }
  if (text === null) {
    return { ...base, known: false, merged: 0, merged_time_unknown: 0, open: 0, ignored_events: 0, opened_to_queue: null, queue_to_merge: null,
      total: null, slowest_step: null, retryable_conflicts: null, blocked_conflicts: null, pending_auto_merge: null };
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
  const pending: PendingAutoMerge[] = [];
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
  return { ...base, known: true, merged, merged_time_unknown: mergedTimeUnknown, open, ignored_events: ignored, opened_to_queue: q, queue_to_merge: m, total: stats(total),
    slowest_step: q.p50_s === null || m.p50_s === null ? null : m.p50_s >= q.p50_s ? 'queue_to_merge' : 'opened_to_queue',
    retryable_conflicts: retryable.sort(byWait), blocked_conflicts: blocked.sort(byPrId),
    pending_auto_merge: pending.sort((a, b) => (b.waiting_s ?? -1) - (a.waiting_s ?? -1) || byPrId(a, b)) };
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
    line('Open to merge', r.total),
    `Pending auto-merge: ${r.pending_auto_merge!.length} (${r.pending_auto_merge!.filter(p => p.stalled).length} stalled after ${r.stalled_after_s}s, ${r.pending_auto_merge!.filter(p => p.stalled === null).length} unknown waits).`,
    ...r.pending_auto_merge!.map(pendingLine),
    r.slowest_step ? `Slowest step: ${r.slowest_step === 'queue_to_merge' ? 'queue to merge' : 'waiting to join the queue'}.` : 'Slowest step: unknown.',
    retry.length ? `Conflicts the recut loop can retry: ${retry.map(c => `#${c.pr} (${c.recut.key})`).join(', ')}` : 'Conflicts the recut loop can retry: none',
    ...r.blocked_conflicts!.map(c => `Needs a person: #${c.pr} (${c.reason})`),
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
      'Types: opened, queued, checks_passed, conflict, recut_requested, merged, closed, auto_merge_enabled, auto_merge_disabled.',
      'Merged window: --hours (default 24). Missing merge times count as missing samples, separately from dated merges.',
      'Open PRs and pending auto-merges include all ages. Enable/disable events describe transitions; queued alone does not imply auto-merge.',
      'Stall age starts at the latest enable transition; --stalled-after defaults to 3600 seconds. Missing or conflicting state times stay unknown.',
      'Inspect required checks, reviews and queue state for stalled PRs. Missing events are counted, not guessed. Unreadable events are unknown.',
    ].join('\n'));
    return 0;
  }
  let path = join(homedir(), '.ashlr-runs', 'metrics', 'merge-events.jsonl');
  let hours = DEFAULT_HOURS;
  let json = false;
  let stalledAfter = DEFAULT_STALLED_AFTER;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) { console.error(`error: duplicate option\n${usage}`); return 2; }
    seen.add(arg);
    if (arg === '--json') json = true;
    else if (arg === '--events' && args[i + 1] && !args[i + 1]!.startsWith('-')) path = args[++i]!;
    else if (arg === '--stalled-after' && /^[1-9]\d{0,7}$/.test(args[i + 1] ?? '')) stalledAfter = Number(args[++i]);
    else if (arg === '--hours' && /^[1-9]\d{0,3}$/.test(args[i + 1] ?? '') && Number(args[i + 1]) <= MAX_HOURS) hours = Number(args[++i]);
    else { console.error(`error: invalid fleet merge-latency arguments\n${usage}`); return 2; }
  }
  const report = await fleetMergeLatency(deps.read ?? readMergeEvents(path), deps.now ?? Date.now(), hours, stalledAfter);
  console.log(json ? JSON.stringify(report) : formatMergeLatency(report));
  return 0;
}
