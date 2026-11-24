/**
 * `phm jobs yield --by source|lane`: which producer or lane earns its launch slots. Pure; the caller
 * passes the jobs ledger lines and, for sources, the `src=` tags from the router queue.
 *
 * A job's source is its `src=` tag when that names a known producer, else its id prefix, else `other`:
 *   leader   leader bets (`src=leader`, ids ending N<day><letter>Q8)
 *   core     Core's RQ-PHX rows
 *   cl-stream the RQ-CL docs and desk stream
 *   guardian the guardian's FIXUP rows
 *   filler   restock filler (`src=filler`, one-test ids such as RQ-MD3A111800Q8)
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readLedgerLines, type YieldLineReader } from './ledger-lines.js';
import { queueProducers } from './job-producers.js';
import { runsRoot } from '../metrics/loop-collect.js';
import { FILLER_ID, JOB_STOP_RATE, YIELD_MIN_LAUNCHES, yieldTally, type YieldRun } from './slot-yield.js';

export type YieldBy = 'source' | 'lane';
export const YIELD_SOURCES = ['leader', 'core', 'cl-stream', 'guardian', 'filler', 'other'] as const;
export type YieldSource = typeof YIELD_SOURCES[number];

/** Tags a producer is known to write, mapped to the source they count as. */
const TAGS: Record<string, YieldSource> = {
  leader: 'leader', bet: 'leader', bets: 'leader', core: 'core', phx: 'core', 'cl-stream': 'cl-stream', cl: 'cl-stream',
  docs: 'cl-stream', guardian: 'guardian', fixup: 'guardian', filler: 'filler', restock: 'filler',
};

/** The source of one job. `tag` is its `src=` value, if any. */
export function jobSource(id: string, tag: string | null = null): YieldSource {
  const named = tag ? TAGS[tag.toLowerCase()] : undefined;
  if (named) return named;
  if (FILLER_ID.test(id)) return 'filler';
  if (/^RQ-PHX-/.test(id)) return 'core';
  if (/^RQ-CL-/.test(id)) return 'cl-stream';
  if (/^FIXUP-/.test(id)) return 'guardian';
  if (/N\d+[A-Z]Q8$/.test(id)) return 'leader';
  return 'other';
}

export interface YieldByRow {
  name: string;
  launches: number;
  prs: number;
  merged: number;
  empty: number;
  aborted: number;
  /** Merged over launches; launches are at least 1 in any row, so this is never unknown. */
  merged_per_launch: number;
  /** Median minutes from launch to the MERGED outcome; null when no merge has a usable time (unknown, not zero). */
  median_minutes_to_merge: number | null;
}

export interface YieldByReport {
  schema: 'jobs.yield-by.v1';
  version: 1;
  by: YieldBy;
  window_hours: number;
  known: boolean;
  launches: number | null;
  /** Lowest merged per launch first; rows under the judging size follow, busiest first. */
  rows: YieldByRow[];
  /** The worst judged row's name; null when none can be judged yet. */
  worst: string | null;
  /** One plain sentence about the worst row. */
  verdict: string;
  /** What this report cannot see. Empty when nothing is missing. */
  gaps: string[];
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function row(name: string, runs: readonly YieldRun[]): YieldByRow {
  const merged = runs.filter(r => r.merged).length;
  const minutes = runs.flatMap(r => r.merged && r.mergedAt !== null ? [(r.mergedAt - r.at) / 60_000] : []);
  return {
    name, launches: runs.length, prs: runs.reduce((sum, r) => sum + r.prs.size, 0), merged,
    empty: runs.filter(r => r.empty).length, aborted: runs.filter(r => r.aborted).length,
    merged_per_launch: merged / runs.length, median_minutes_to_merge: median(minutes),
  };
}

/** The plain sentence for the worst row, e.g. `filler: 2 merged of 40 launches, consider stopping it`. */
export function worstYield(rows: readonly YieldByRow[], by: YieldBy, hours: number): { worst: string | null; verdict: string } {
  if (!rows.length) return { worst: null, verdict: `No launches in the last ${plural(hours, 'hour')}` };
  const judged = rows.filter(r => r.launches >= YIELD_MIN_LAUNCHES);
  const worst = judged[0];
  if (!worst) return { worst: null, verdict: `No ${by} has ${YIELD_MIN_LAUNCHES} launches yet, too early to judge` };
  const count = `${worst.name}: ${worst.merged} merged of ${plural(worst.launches, 'launch', 'launches')}`;
  // `other` and `unknown` are catch-alls, so they are never told to stop as one unit.
  const stoppable = worst.merged_per_launch < JOB_STOP_RATE && worst.name !== 'other' && worst.name !== 'unknown';
  return { worst: worst.name, verdict: `${count}${stoppable ? ', consider stopping it' : ', the lowest yield'}` };
}

/** Rank: judged rows by merged per launch (lowest first), then the rest, busiest first. */
function rank(rows: YieldByRow[]): YieldByRow[] {
  const judged = (r: YieldByRow) => r.launches >= YIELD_MIN_LAUNCHES;
  return rows.sort((a, b) => Number(judged(b)) - Number(judged(a))
    || (judged(a) ? a.merged_per_launch - b.merged_per_launch : 0) || b.launches - a.launches || a.name.localeCompare(b.name));
}

export function unknownYieldBy(by: YieldBy, hours: number): YieldByReport {
  return { schema: 'jobs.yield-by.v1', version: 1, by, window_hours: hours, known: false, launches: null, rows: [], worst: null,
    verdict: 'Job yield: unknown (job metrics file unreadable)', gaps: ['job metrics file unreadable'] };
}

/** `queue` null means the router queue could not be read; sources then rest on launch tags and id prefixes. */
export function yieldBy(lines: Iterable<string>, by: YieldBy, now: number, hours: number, queue: Map<string, string> | null = null): YieldByReport {
  const tally = yieldTally(now, hours);
  for (const line of lines) tally.add(line);
  const runs = tally.runs();
  const groups = new Map<string, YieldRun[]>();
  for (const run of runs) {
    const key = by === 'lane' ? run.lane : jobSource(run.job, run.src ?? queue?.get(run.job) ?? null);
    const members = groups.get(key);
    if (members) members.push(run); else groups.set(key, [run]);
  }
  const rows = rank([...groups].map(([name, members]) => row(name, members)));
  const gaps: string[] = [];
  if (by === 'source' && queue === null) gaps.push('router queue unreadable: sources come from launch tags and job id prefixes only');
  if (rows.some(r => r.merged > 0 && r.median_minutes_to_merge === null)) gaps.push('some merges have no usable time: median minutes to merge is unknown for them');
  return { schema: 'jobs.yield-by.v1', version: 1, by, window_hours: hours, known: true, launches: runs.length, rows,
    ...worstYield(rows, by, hours), gaps };
}

export function yieldByLines(report: YieldByReport): string[] {
  if (!report.known) return [report.verdict];
  const minutes = (value: number | null) => value === null ? 'unknown' : `${Math.round(value)} min`;
  return [
    report.verdict,
    ...report.rows.map(r => `  ${r.name}: ${r.launches} launches, ${r.prs} PRs, ${r.merged} merged, ${r.empty} empty, ${r.aborted} aborted; merged per launch ${r.merged_per_launch.toFixed(2)}; median to merge ${minutes(r.median_minutes_to_merge)}`),
    ...report.gaps.map(g => `Gap: ${g}`),
  ];
}

const MAX_QUEUE_BYTES = 8 * 1024 * 1024;

/** Read the ledger (and, for sources, the router queue). An unreadable ledger is unknown, never zero. */
export async function readYieldBy(opts: { by: YieldBy; hours?: number; now?: number; metrics?: string; queue?: string; read?: YieldLineReader }): Promise<YieldByReport> {
  const { by, hours = 24, now = Date.now(), read = readLedgerLines } = opts;
  const root = runsRoot();
  const lines: string[] = [];
  try {
    if (!await read(opts.metrics ?? join(root, 'metrics', 'jobs.jsonl'), line => lines.push(line))) return unknownYieldBy(by, hours);
  } catch { return unknownYieldBy(by, hours); }
  let queue: Map<string, string> | null = null;
  if (by === 'source') {
    try {
      const text = await readFile(opts.queue ?? join(root, 'queue', 'router-queue.md'), 'utf8');
      if (text.length <= MAX_QUEUE_BYTES) queue = queueProducers(text);
    } catch { /* queue unknown: reported as a gap */ }
  }
  return yieldBy(lines, by, now, hours, queue);
}

/** The digest line: the worst source over the last 24 hours, or null when none can be judged or the ledger is unreadable. */
export function yieldDigestLine(report: YieldByReport): string | null {
  return report.known && report.worst ? `yield_low: ${report.verdict}` : null;
}
