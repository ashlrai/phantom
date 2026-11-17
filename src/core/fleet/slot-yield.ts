/**
 * Launch-slot yield: merged PRs per launch, grouped by job family, lane and tier.
 *
 * Pure. Reads job-metrics ledger lines (`metrics/jobs.jsonl`) and never touches
 * the filesystem; `src/cli/fleet-yield.ts` owns I/O.
 *
 * Counting model: every `launch` row inside the window is one run. A relaunched
 * job id is several runs. `finish` rows pair with the job's earliest unfinished
 * run, `publish` rows with its latest run, and the job's last `outcome` row is
 * credited once, to the run that opened the PR (else the latest run).
 */

export const YIELD_MIN_LAUNCHES = 5;

/**
 * The family a job id belongs to: the id minus its trailing cycle or sequence part.
 *
 * - Leader jobs end in `N<digits><letter>Q8` (RQ-SLOTYIELDN16NQ8): family `leader`.
 * - A separate numeric last segment is a sequence: `RQ-PR-LEVERAGE-1` -> `RQ-PR-LEVERAGE*`.
 * - Generated ids glue a cycle code to the last word (`RECUTAPIC500`, `SLACKCOMPOSER498S`,
 *   `LOCUS1A111623Q8`). Everything from the first digit is the cycle, and the rest of the word
 *   starts with a five-letter kind followed by a free-text area, so the family keeps the first
 *   five letters: `RQ-PHX-RECUTAPIC500` and `RQ-PHX-RECUTCOREC497` -> `RQ-PHX-RECUT*`,
 *   `RQ-LOCUS1A111623Q8` -> `RQ-LOCUS*`.
 * - Ids with no digits have no cycle and are their own family.
 */
export function jobFamily(id: string): string {
  if (/N\d+[A-Z]Q8$/.test(id)) return 'leader';
  const dashed = /^(.+?)-\d+$/.exec(id);
  if (dashed) return `${dashed[1]}*`;
  const glued = /^(.*-)?([A-Za-z]+)\d[A-Za-z0-9]*$/.exec(id);
  if (glued) return `${glued[1] ?? ''}${glued[2]!.slice(0, 5)}*`;
  return id;
}

export interface YieldRow {
  name: string;
  launches: number;
  prs: number;
  merged: number;
  empty: number;
  aborted: number;
  /** Runs with a finish row; tokens and run seconds come only from these. */
  finished: number;
  median_run_s: number | null;
  /** Sum over finished runs that reported tokens; null when none did (unknown, not zero). */
  tokens: number | null;
  tokens_measured: number;
  merged_per_launch: number;
  /** Null unless something merged and every finished run reported tokens. */
  tokens_per_merged: number | null;
  verdict: string;
}

export interface YieldReport {
  schema: 'fleet.yield.v1';
  window_hours: number;
  known: boolean;
  launches: number;
  families: YieldRow[];
  lanes: YieldRow[];
  tiers: YieldRow[];
}

interface Run {
  job: string; lane: string; tier: string;
  finished: boolean; empty: boolean; aborted: boolean;
  wall: number | null; tokens: number | null;
  prs: Set<string>; merged: boolean;
}

const word = (value: unknown): string =>
  typeof value === 'string' && /^[\w.:@/-]{1,80}$/.test(value.trim()) ? value.trim() : 'unknown';
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export function yieldVerdict(row: Omit<YieldRow, 'verdict'>): string {
  const parts = [`${row.name}: ${plural(row.prs, 'PR')} from ${plural(row.launches, 'launch', 'launches')}`, `${row.merged} merged`, `${row.empty} empty`];
  if (row.aborted) parts.push(`${row.aborted} aborted`);
  parts.push(row.tokens_per_merged === null ? 'tokens per merged PR unknown' : `${Math.round(row.tokens_per_merged)} tokens per merged PR`);
  return parts.join(', ');
}

function summarize(name: string, runs: Run[]): YieldRow {
  const finished = runs.filter(r => r.finished);
  const measured = finished.filter(r => r.tokens !== null);
  const tokens = measured.length ? measured.reduce((sum, r) => sum + r.tokens!, 0) : null;
  const merged = runs.filter(r => r.merged).length;
  const row = {
    name,
    launches: runs.length,
    prs: runs.reduce((sum, r) => sum + r.prs.size, 0),
    merged,
    empty: runs.filter(r => r.empty).length,
    aborted: runs.filter(r => r.aborted).length,
    finished: finished.length,
    median_run_s: median(finished.flatMap(r => r.wall === null ? [] : [r.wall])),
    tokens,
    tokens_measured: measured.length,
    merged_per_launch: runs.length ? merged / runs.length : 0,
    tokens_per_merged: tokens !== null && merged > 0 && measured.length === finished.length ? tokens / merged : null,
  };
  return { ...row, verdict: yieldVerdict(row) };
}

/** Worst yield first among rows with enough launches to judge; small rows follow, busiest first. */
function rank(rows: YieldRow[]): YieldRow[] {
  const judged = (r: YieldRow) => r.launches >= YIELD_MIN_LAUNCHES;
  return rows.sort((a, b) => Number(judged(b)) - Number(judged(a))
    || (judged(a) ? a.merged_per_launch - b.merged_per_launch : 0)
    || b.launches - a.launches || a.name.localeCompare(b.name));
}

function group(runs: Run[], key: (run: Run) => string): YieldRow[] {
  const groups = new Map<string, Run[]>();
  for (const run of runs) {
    const members = groups.get(key(run));
    if (members) members.push(run); else groups.set(key(run), [run]);
  }
  return rank([...groups].map(([name, members]) => summarize(name, members)));
}

/** Incremental tally so callers can stream a large ledger line by line. */
export function yieldTally(now: number, hours: number): { add(line: string): void; report(): YieldReport } {
  if (!Number.isFinite(hours) || hours <= 0) throw new RangeError('Hours must be positive.');
  const start = now - hours * 3_600_000;
  const byJob = new Map<string, Run[]>();
  const outcomes = new Map<string, string>();
  return {
    add(line: string) {
      let row: Record<string, unknown>;
      try {
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return;
        row = value as Record<string, unknown>;
      } catch { return; }
      const job = word(row.job);
      if (job === 'unknown') return;
      // Accept `+0000` offsets as well as ISO `+00:00`.
      const at = typeof row.ts === 'string' ? Date.parse(row.ts.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) : NaN;
      // Rows from before the window cannot belong to a run launched inside it.
      if (Number.isFinite(at) && at < start) return;
      const runs = byJob.get(job);
      if (row.event === 'launch') {
        if (!Number.isFinite(at) || at > now) return;
        const run: Run = { job, lane: word(row.lane), tier: word(row.tier), finished: false, empty: false, aborted: false, wall: null, tokens: null, prs: new Set(), merged: false };
        if (runs) runs.push(run); else byJob.set(job, [run]);
        return;
      }
      if (!runs) return; // launched before the window, or never seen launching
      if (row.event === 'finish') {
        const run = runs.find(r => !r.finished);
        if (!run) return;
        run.finished = true;
        run.empty ||= row.empty === true;
        run.wall = count(row.wall_s);
        run.tokens = count(row.tokens_total);
      } else if (row.event === 'publish') {
        const run = runs[runs.length - 1]!, kind = word(row.class);
        if (kind === 'pr') run.prs.add(typeof row.url === 'string' && row.url ? row.url : `pr:${run.prs.size}`);
        else if (kind === 'empty') run.empty = true;
        else if (kind.startsWith('abort')) run.aborted = true;
      } else if (row.event === 'outcome') {
        outcomes.set(job, word(row.state).toUpperCase());
      }
    },
    report(): YieldReport {
      for (const [job, state] of outcomes) {
        if (state !== 'MERGED') continue;
        const runs = byJob.get(job)!;
        const withPr = runs.filter(r => r.prs.size > 0);
        (withPr[withPr.length - 1] ?? runs[runs.length - 1]!).merged = true;
      }
      const runs = [...byJob.values()].flat();
      return {
        schema: 'fleet.yield.v1', window_hours: hours, known: true, launches: runs.length,
        families: group(runs, r => jobFamily(r.job)),
        lanes: group(runs, r => r.lane),
        tiers: group(runs, r => r.tier),
      };
    },
  };
}

export function fleetYield(lines: Iterable<string>, now: number, hours: number): YieldReport {
  const tally = yieldTally(now, hours);
  for (const line of lines) tally.add(line);
  return tally.report();
}

export function unknownYield(hours: number): YieldReport {
  return { schema: 'fleet.yield.v1', window_hours: hours, known: false, launches: 0, families: [], lanes: [], tiers: [] };
}
