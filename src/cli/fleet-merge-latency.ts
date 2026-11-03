/**
 * Read-only merge latency: how long PRs wait for the queue and for the merge,
 * and which conflicts the recut automation can safely retry. Advisory only:
 * nothing here merges, requeues or skips a required check.
 */
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { recutRequest, type MergeRecutRequest } from '../core/merge-eta.js';

const usage = 'Usage: ashlr fleet merge-latency [--events <file>] [--hours <n>] [--json]';
const SCHEMA = 'fleet.merge-latency.v1';
const DEFAULT_HOURS = 24;
const MAX_HOURS = 24 * 30;
const MAX_BYTES = 8 * 1024 * 1024;
/** After this many recut requests for one PR, a person should look at it. */
const MAX_RECUTS = 3;

export type MergeEventType = 'opened' | 'queued' | 'checks_passed' | 'conflict' | 'recut_requested' | 'merged';
const TYPES: ReadonlySet<string> = new Set<MergeEventType>(['opened', 'queued', 'checks_passed', 'conflict', 'recut_requested', 'merged']);

/** One JSON object per line. `head_sha` is read from conflict and recut_requested events. */
export interface MergeEvent { repo: string; pr: number; type: MergeEventType; at: string; head_sha?: string }

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
      typeof r.type !== 'string' || !TYPES.has(r.type) || typeof r.at !== 'string' || !Number.isFinite(Date.parse(r.at))) return null;
  return { repo: r.repo.toLowerCase(), pr: r.pr as number, type: r.type as MergeEventType, at: r.at,
    ...(typeof r.head_sha === 'string' ? { head_sha: r.head_sha } : {}) };
}

const gap = (from: number | undefined, to: number | undefined): number | null =>
  from === undefined || to === undefined || to < from ? null : Math.round((to - from) / 1000);

export async function fleetMergeLatency(read: MergeEventReader, now = Date.now(), hours = DEFAULT_HOURS): Promise<MergeLatencyReport> {
  const base = { schema: SCHEMA, window_hours: hours } as const;
  let text: string | null;
  try { text = await read(); } catch { text = null; }
  if (text === null) {
    return { ...base, known: false, merged: 0, open: 0, ignored_events: 0, opened_to_queue: null, queue_to_merge: null,
      total: null, slowest_step: null, retryable_conflicts: null, blocked_conflicts: null };
  }
  const since = now - hours * 3_600_000;
  const byPr = new Map<string, MergeEvent[]>();
  let ignored = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const event = parseEvent(line);
    if (!event || Date.parse(event.at) > now) { ignored++; continue; }
    const key = `${event.repo}#${event.pr}`;
    byPr.set(key, [...(byPr.get(key) ?? []), event]);
  }
  const toQueue: (number | null)[] = [];
  const toMerge: (number | null)[] = [];
  const total: (number | null)[] = [];
  const retryable: RetryableConflict[] = [];
  const blocked: BlockedConflict[] = [];
  let merged = 0;
  let open = 0;
  for (const events of byPr.values()) {
    // Stable sort: events sharing a timestamp keep their file order.
    events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const last = events[events.length - 1]!;
    if (Date.parse(last.at) < since) continue;
    const first = (type: MergeEventType) => { const e = events.find(x => x.type === type); return e ? Date.parse(e.at) : undefined; };
    const { repo, pr } = last;
    const mergedAt = first('merged');
    if (mergedAt !== undefined) {
      merged++;
      toQueue.push(gap(first('opened'), first('queued')));
      toMerge.push(gap(first('queued'), mergedAt));
      total.push(gap(first('opened'), mergedAt));
      continue;
    }
    open++;
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
    else if (asked.some(e => Date.parse(e.at) >= Date.parse(events[conflict]!.at) && (!e.head_sha || e.head_sha.toLowerCase().startsWith(request.headSha.slice(0, 7))))) {
      blocked.push({ repo, pr, reason: 'already-requested' });
    } else retryable.push({ repo, pr, head_sha: request.headSha, waiting_s: Math.max(0, Math.round((now - Date.parse(events[conflict]!.at)) / 1000)), recut: request });
  }
  const byWait = (a: { waiting_s: number }, b: { waiting_s: number }) => b.waiting_s - a.waiting_s;
  const byPrId = (a: { repo: string; pr: number }, b: { repo: string; pr: number }) => a.repo.localeCompare(b.repo) || a.pr - b.pr;
  const q = stats(toQueue);
  const m = stats(toMerge);
  return { ...base, known: true, merged, open, ignored_events: ignored, opened_to_queue: q, queue_to_merge: m, total: stats(total),
    slowest_step: q.p50_s === null || m.p50_s === null ? null : m.p50_s >= q.p50_s ? 'queue_to_merge' : 'opened_to_queue',
    retryable_conflicts: retryable.sort(byWait), blocked_conflicts: blocked.sort(byPrId) };
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

export function formatMergeLatency(r: MergeLatencyReport): string {
  if (!r.known) return 'Merge latency: unknown (events unreadable)';
  const retry = r.retryable_conflicts!;
  return [
    `Last ${r.window_hours} hours: ${r.merged} merged, ${r.open} still open.`,
    line('Waiting to join the queue', r.opened_to_queue),
    line('Queue to merge', r.queue_to_merge),
    line('Open to merge', r.total),
    r.slowest_step ? `Slowest step: ${r.slowest_step === 'queue_to_merge' ? 'queue to merge' : 'waiting to join the queue'}.` : 'Slowest step: unknown.',
    retry.length ? `Conflicts the recut loop can retry: ${retry.map(c => `#${c.pr} (${c.recut.key})`).join(', ')}` : 'Conflicts the recut loop can retry: none',
    ...r.blocked_conflicts!.map(c => `Needs a person: #${c.pr} (${c.reason})`),
    ...(r.ignored_events ? [`${r.ignored_events} unreadable events skipped.`] : []),
  ].join('\n');
}

export interface MergeLatencyDeps { read?: MergeEventReader; now?: number }

export async function cmdFleetMergeLatency(args: string[], deps: MergeLatencyDeps = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nShow how long PRs wait to join the merge queue and to merge (median and 90th percentile), and which conflicts the recut loop can retry. Reads ~/.ashlr-runs/metrics/merge-events.jsonl or --events; one JSON event per line: repo, pr, type (opened, queued, checks_passed, conflict, recut_requested, merged), at, head_sha. Read-only: required checks are never skipped. Missing events are counted, not guessed. Unreadable events are unknown.`);
    return 0;
  }
  let path = join(homedir(), '.ashlr-runs', 'metrics', 'merge-events.jsonl');
  let hours = DEFAULT_HOURS;
  let json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) { console.error(`error: duplicate option\n${usage}`); return 2; }
    seen.add(arg);
    if (arg === '--json') json = true;
    else if (arg === '--events' && args[i + 1]) path = args[++i]!;
    else if (arg === '--hours' && /^[1-9]\d{0,3}$/.test(args[i + 1] ?? '') && Number(args[i + 1]) <= MAX_HOURS) hours = Number(args[++i]);
    else { console.error(`error: invalid fleet merge-latency arguments\n${usage}`); return 2; }
  }
  const report = await fleetMergeLatency(deps.read ?? readMergeEvents(path), deps.now ?? Date.now(), hours);
  console.log(json ? JSON.stringify(report) : formatMergeLatency(report));
  return 0;
}
