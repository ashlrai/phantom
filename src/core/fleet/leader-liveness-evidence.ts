import { join } from 'node:path';
import { readSource } from './runs-parked-queue.js';

/**
 * Read-only leader liveness evidence (recovered from #6999). It is evidence only: a stale age
 * grants no authority and changes no routing. Anything missing, unreadable or unparseable is
 * `null` (unknown), never 0 / healthy.
 */
export interface LeaderLiveness {
  /** Planner heading evidence: newest `## <date>` entry of leader/PLAN-LOG.md. */
  source: 'leader/PLAN-LOG.md';
  as_of: string | null;
  /** How the heading time was read: explicit zone, or the log's approximate "~HH:MM ET" heading. */
  time_basis: 'explicit-zone' | 'approximate-america-new_york' | null;
  age_seconds: number | null;
  age_hours: number | null;
  /** True when the age exceeds two hours; null when age is unknown. Evidence only. */
  flagged_red: boolean | null;
  /** OPUS-LEADER sha-mismatch refusals with a valid, non-future timestamp in the prior 24h. */
  mismatch_source: 'queue/dispatch-events.log';
  mismatch_window_hours: 24;
  /** null = events log missing/unreadable (unknown, not zero). */
  mismatch_count: number | null;
  /** Matching lines whose timestamp was absent, ambiguous or in the future (not counted). */
  mismatch_unusable_lines: number | null;
  authority: 'none';
}

const PLAN_LOG_MAX = 256 * 1024;
const EVENTS_MAX = 1024 * 1024;
const WINDOW_MS = 24 * 3_600_000;
const STALE_SECONDS = 2 * 3600;
const MISMATCH = 'OPUS-LEADER loop sha mismatch, refused';
const ZONED = /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2}))(?![\d])/;
const ET_HEADING = /^## (\d{4})-(\d{2})-(\d{2}) ~?(\d{1,2}):(\d{2}) ET\s*$/;

const nyParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23',
  year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });

/** Wall-clock America/New_York to epoch ms; null when the wall time is ambiguous or nonexistent (DST). */
export function newYorkWallToEpoch(y: number, mo: number, d: number, h: number, mi: number): number | null {
  if (h > 23 || mi > 59) return null;
  const hits = new Set<number>();
  for (const offset of [4, 5]) {
    const t = Date.UTC(y, mo - 1, d, h + offset, mi);
    const p = Object.fromEntries(nyParts.formatToParts(t).map(x => [x.type, Number(x.value)]));
    if (p.year === y && p.month === mo && p.day === d && p.hour === h && p.minute === mi) hits.add(t);
  }
  return hits.size === 1 ? [...hits][0]! : null;
}

/** Parse only explicitly zoned ISO timestamps; never falls back to machine-local interpretation. */
export function parseZoned(text: string): number | null {
  const m = ZONED.exec(text);
  if (!m) return null;
  const t = Date.parse(m[1]!.replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isFinite(t) ? t : null;
}

function headingTime(line: string): { at: number; basis: NonNullable<LeaderLiveness['time_basis']> } | null {
  const et = ET_HEADING.exec(line);
  if (et) {
    const at = newYorkWallToEpoch(+et[1]!, +et[2]!, +et[3]!, +et[4]!, +et[5]!);
    return at === null ? null : { at, basis: 'approximate-america-new_york' };
  }
  const at = parseZoned(line);
  return at === null ? null : { at, basis: 'explicit-zone' };
}

/** Time of the newest `## <date>` heading in PLAN-LOG text; null when absent, malformed, ambiguous or in the future. */
export function newestHeadingAt(text: string, now: number): { at: number; basis: NonNullable<LeaderLiveness['time_basis']> } | null {
  const last = text.split('\n').filter(l => /^## \d{4}-\d{2}-\d{2}/.test(l)).pop();
  const parsed = last ? headingTime(last) : null;
  return parsed && parsed.at <= now ? parsed : null;
}

export async function readLeaderLiveness(root: string, now = Date.now()): Promise<LeaderLiveness> {
  const out: LeaderLiveness = { source: 'leader/PLAN-LOG.md', as_of: null, time_basis: null, age_seconds: null, age_hours: null,
    flagged_red: null, mismatch_source: 'queue/dispatch-events.log', mismatch_window_hours: 24, mismatch_count: null,
    mismatch_unusable_lines: null, authority: 'none' };
  const [plan, events] = await Promise.all([
    readSource(join(root, 'leader/PLAN-LOG.md'), PLAN_LOG_MAX, true),
    readSource(join(root, 'queue/dispatch-events.log'), EVENTS_MAX, true),
  ]);
  if (plan.state === 'healthy') {
    // Newest dated heading decides; if it is malformed, ambiguous or in the future the age stays unknown.
    const parsed = newestHeadingAt(plan.text, now);
    if (parsed) {
      out.as_of = new Date(parsed.at).toISOString();
      out.time_basis = parsed.basis;
      out.age_seconds = Math.floor((now - parsed.at) / 1000);
      out.age_hours = out.age_seconds / 3600;
      out.flagged_red = out.age_seconds > STALE_SECONDS;
    }
  }
  if (events.state === 'healthy') {
    let count = 0, unusable = 0;
    for (const line of events.text.split('\n')) {
      if (!line.includes(MISMATCH)) continue;
      const at = parseZoned(line);
      if (at !== null && at <= now && at >= now - WINDOW_MS) count++;
      else if (at === null || at > now) unusable++;
    }
    out.mismatch_count = count;
    out.mismatch_unusable_lines = unusable;
  }
  return out;
}

export function leaderLivenessLine(l: LeaderLiveness): string {
  const age = l.age_seconds === null ? 'unknown' : `${l.age_hours!.toFixed(1)}h${l.time_basis === 'approximate-america-new_york' ? ' (approximate, ET heading)' : ''}`;
  return `Leader liveness: planner age ${age}${l.flagged_red ? ' (stale, evidence only)' : ''}; mismatches (24h) ${l.mismatch_count ?? 'unknown'}`;
}
