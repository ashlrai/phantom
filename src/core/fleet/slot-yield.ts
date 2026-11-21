/**
 * Launch-slot yield: merged PRs per launch, grouped by job family, lane and tier.
 *
 * Pure. Reads job-metrics ledger lines (`metrics/jobs.jsonl`) and never touches
 * the filesystem; `src/cli/fleet-yield.ts` owns I/O.
 *
 * Counting model: every `launch` row inside the window is one run. A relaunched
 * job id is several runs. `finish` rows pair with the job's earliest unfinished
 * run, `publish` rows with its latest run, and the job's last `outcome` row is
 * credited once, to the run that opened the PR (else the latest run). A merge
 * recorded as reverted (`hasRevertEvidence`) is credited as `reverted`, never
 * as a held merge — the same rule the router outcome fold applies.
 *
 * Rows fold through the fleet's jobs-ledger dialect (the field sets below
 * `yieldTally`): reconciler outcome rows keyed by `jobId`/`prUrl`/`outcome`/
 * `status`, `type`/`kind` event spellings, the `pool` lane alias, timestamp
 * aliases and eventless resolved-PR phases all count, so GitHub-resolved
 * merges are not invisible.
 *
 * `jobYield()` reads the same tally as `phm jobs yield` (`jobs.yield.v1`): finer
 * job kinds, precheck skips, and a keep / watch / stop verdict per kind.
 */

import { parseLedgerTs } from '../metrics/loop.js';
import type { JobsEmptyWhy } from './jobs-empty-why.js';
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

/** Author filler ids: RQ-, a repo code in capital letters, digits, A, digits, Q8. */
export const FILLER_ID = /^RQ-([A-Z]+)[0-9]+A[0-9]+Q8$/;

/**
 * The job kind `phm jobs yield` judges: the id minus its trailing counter. Finer than `jobFamily`,
 * so one recut area can be stopped while another keeps running.
 *
 * - Filler ids (`RQ-MD3A111800Q8`) -> `one-test filler <repo>`; the repo is the launch row's, else the id's repo code.
 * - A closing `Q8` queue stamp is dropped, with the leader's `N<day><letter>` before it:
 *   `RQ-SLOTYIELDN16NQ8` -> `RQ-SLOTYIELD`, `RQ-RECUTDEDUPQ8` -> `RQ-RECUTDEDUP`.
 * - A last `-<digits>` or `-N<digits>` segment is dropped: `RQ-PR-LEVERAGE-1` -> `RQ-PR-LEVERAGE`.
 * - A glued cycle is dropped: `C<digits>` at the end (`RQ-PHX-RECUTCOREC566` -> `RQ-PHX-RECUTCORE`),
 *   else everything from the first digit that follows a letter (`SLACKCOMPOSER498S` -> `SLACKCOMPOSER`).
 *   A word that really ends in C before its digits loses that C; the rule cannot tell the two apart.
 */
export function jobKind(id: string, repo = 'unknown'): string {
  const filler = FILLER_ID.exec(id);
  if (filler) return `one-test filler ${repo === 'unknown' ? filler[1]!.toLowerCase() : repo}`;
  const kind = id.replace(/(?:N\d+[A-Z]?)?Q8$/, '').replace(/-N?\d+$/, '').replace(/(?<=[A-Za-z])(?:C\d+|\d[A-Za-z0-9]*)$/, '').replace(/-+$/, '');
  return kind || id;
}

export type JobVerdict = 'keep' | 'watch' | 'stop';
/** Merged per launch at or above this is worth launching again. */
export const JOB_KEEP_RATE = 0.3;
/** Merged per launch under this, over enough launches, is a kind to stop. */
export const JOB_STOP_RATE = 0.1;
/** Launches that must have ended before a kind can be told to stop. */
export const JOB_STOP_MIN_LAUNCHES = 6;
/** A merge in this many newest launches keeps a kind live, whatever its rate. */
export const JOB_RECENT_LAUNCHES = 3;
export const JOB_STOP_FIRST_LIMIT = 5;

export interface JobYieldFamily {
  family: string;
  /** Launch slots used in the window. */
  launches: number;
  /** Launches with no finish, publish or merge yet. They never count toward a stop verdict. */
  running: number;
  empty: number;
  /** Precheck skip rows: the job was turned away before it took a slot. */
  skipped: number;
  prs: number;
  merged: number;
  /** Launches whose merge was recorded as reverted; never counted in `merged`. */
  reverted: number;
  /** Null when nothing launched (unknown, not zero). */
  merged_per_launch: number | null;
  verdict: JobVerdict;
  /** The counts behind the verdict, in plain words. */
  reason: string;
}

export interface JobYieldStop { family: string; slots: number; merged: number; reason: string }

/** `known: false` means the ledger could not be read: totals are null and the lists are empty. */
export interface JobYieldReport {
  empty_why?: JobsEmptyWhy;
  schema: 'jobs.yield.v1';
  version: 1;
  window_hours: number;
  known: boolean;
  launches: number | null;
  merged: number | null;
  /** Launches whose merge was recorded as reverted; null when the read is unknown. */
  reverted: number | null;
  empty: number | null;
  skipped: number | null;
  /** Launch slots that went to kinds with a stop verdict. */
  stop_slots: number | null;
  /** One plain sentence for a person. */
  summary: string;
  /** Stop first, then watch, then keep; most launches first inside each. */
  families: JobYieldFamily[];
  /** At most five kinds to stop, most slots used first. */
  stop_first: JobYieldStop[];
}

export interface YieldRow {
  name: string;
  launches: number;
  prs: number;
  merged: number;
  /** Launches whose merge was recorded as reverted; never counted in `merged`. */
  reverted: number;
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
  /** `at` is the launch time; `last` the newest timestamped row for the run (epoch ms). */
  job: string; lane: string; tier: string; repo: string; /** From the launch row; null when it named none. */ model: string | null; at: number; last: number;
  finished: boolean; empty: boolean; aborted: boolean;
  wall: number | null; tokens: number | null;
  prs: Set<string>; merged: boolean; reverted: boolean;
}

const word = (value: unknown): string =>
  typeof value === 'string' && /^[\w.:@/-]{1,80}$/.test(value.trim()) ? value.trim() : 'unknown';
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

// Revert evidence uses the same field vocabulary the router outcome fold
// honors: a reverted:true flag, a parseable reverted_at/revertedAt stamp, a
// revert/reverted event name, or a revert/reverted terminal state field.
const REVERT_NAMES: ReadonlySet<string> = new Set(['revert', 'reverted']);
const REVERT_EVENT_KEYS = ['event', 'type', 'kind'];
const REVERT_STATE_KEYS = ['phase', 'state', 'outcome', 'status', 'result', 'conclusion'];
const hasRevertName = (row: Record<string, unknown>, keys: readonly string[]): boolean =>
  keys.some(k => {
    const v = row[k];
    return typeof v === 'string' && REVERT_NAMES.has(v.trim().toLowerCase());
  });
/** True when one ledger row carries positive revert evidence for its job. Explicit `reverted:false` is not evidence. */
export function hasRevertEvidence(row: Record<string, unknown>): boolean {
  if (row['reverted'] === true) return true;
  for (const k of ['reverted_at', 'revertedAt']) {
    const v = row[k];
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Date.parse(v))) return true;
  }
  return hasRevertName(row, REVERT_EVENT_KEYS) || hasRevertName(row, REVERT_STATE_KEYS);
}
/** Terminal outcome states that mean the recorded merge did not hold. */
const REVERT_OUTCOMES: ReadonlySet<string> = new Set(['REVERT', 'REVERTED']);

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * keep: merged per launch at least 0.3. stop: at least 6 ended launches, merged per launch under 0.1
 * (so no merges from 6, or 1 from 11 or more) and no merge in its last 3 launches (`recentMerge`).
 * Everything else, including a kind that never launched, is watch.
 */
export function jobVerdict(row: Pick<JobYieldFamily, 'launches' | 'running' | 'merged'> & { recentMerge?: boolean }): JobVerdict {
  if (row.launches <= 0) return 'watch';
  const rate = row.merged / row.launches;
  if (rate >= JOB_KEEP_RATE) return 'keep';
  return row.launches - row.running >= JOB_STOP_MIN_LAUNCHES && rate < JOB_STOP_RATE && !row.recentMerge ? 'stop' : 'watch';
}

/** The report plus the job ids seen per kind, which the stop file needs to check its patterns. */
export interface JobYieldParts { report: JobYieldReport; ids: Map<string, string[]> }

function jobYieldParts(runs: Run[], skips: Map<string, { repo: string; rows: number }>, hours: number): JobYieldParts {
  const rows = new Map<string, Omit<JobYieldFamily, 'merged_per_launch' | 'verdict' | 'reason'> & { ids: Set<string>; newest: boolean[] }>();
  const row = (family: string, job: string) => {
    let hit = rows.get(family);
    if (!hit) rows.set(family, hit = { family, launches: 0, running: 0, empty: 0, skipped: 0, prs: 0, merged: 0, reverted: 0, ids: new Set(), newest: [] });
    hit.ids.add(job);
    return hit;
  };
  const repos = new Map<string, string>();
  // Oldest launch first, so `newest` ends with each kind's latest launches.
  for (const run of [...runs].sort((a, b) => a.at - b.at)) {
    if (run.repo !== 'unknown') repos.set(run.job, run.repo);
    const hit = row(jobKind(run.job, run.repo), run.job);
    hit.launches++;
    hit.newest.push(run.merged);
    hit.prs += run.prs.size;
    if (run.merged) hit.merged++;
    if (run.reverted) hit.reverted++;
    if (run.empty) hit.empty++;
    if (!run.finished && !run.empty && !run.aborted && !run.merged && !run.reverted && run.prs.size === 0) hit.running++;
  }
  for (const [job, skip] of skips) row(jobKind(job, skip.repo !== 'unknown' ? skip.repo : repos.get(job)), job).skipped += skip.rows;
  const order: Record<JobVerdict, number> = { stop: 0, watch: 1, keep: 2 };
  const families = [...rows.values()].map(({ ids: _ids, newest, ...r }): JobYieldFamily => {
    const recentMerge = newest.slice(-JOB_RECENT_LAUNCHES).some(Boolean);
    const reason = [`${r.merged} merged from ${plural(r.launches, 'launch', 'launches')}`, r.reverted ? `${r.reverted} reverted` : '',
      r.empty ? `${r.empty} empty` : '', r.running ? `${r.running} still running` : '', r.skipped ? `${r.skipped} skipped before launch` : ''].filter(Boolean).join(', ');
    return { ...r, merged_per_launch: r.launches ? r.merged / r.launches : null, verdict: jobVerdict({ ...r, recentMerge }), reason };
  }).sort((a, b) => order[a.verdict] - order[b.verdict] || b.launches - a.launches
    || (a.merged_per_launch ?? 0) - (b.merged_per_launch ?? 0) || a.family.localeCompare(b.family));
  const stops = families.filter(r => r.verdict === 'stop');
  const stopSlots = stops.reduce((sum, r) => sum + r.launches, 0);
  const merged = families.reduce((sum, r) => sum + r.merged, 0);
  const summary = !runs.length ? `No launches in the last ${plural(hours, 'hour')}`
    : !stops.length ? `${plural(runs.length, 'launch', 'launches')}, ${merged} merged; no job kind to stop`
    : `${stopSlots} of ${plural(runs.length, 'launch', 'launches')} went to ${plural(stops.length, 'job kind')} that ${stops.some(r => r.merged) ? 'rarely merge' : 'merged nothing'}`;
  return { ids: new Map([...rows].map(([family, r]) => [family, [...r.ids]])), report: {
    schema: 'jobs.yield.v1', version: 1, window_hours: hours, known: true, launches: runs.length, merged,
    reverted: families.reduce((sum, r) => sum + r.reverted, 0),
    empty: families.reduce((sum, r) => sum + r.empty, 0), skipped: families.reduce((sum, r) => sum + r.skipped, 0),
    stop_slots: stopSlots, summary, families,
    stop_first: stops.slice(0, JOB_STOP_FIRST_LIMIT).map(r => ({ family: r.family, slots: r.launches, merged: r.merged, reason: r.reason })),
  } };
}

export function unknownJobYield(hours: number): JobYieldReport {
  return { schema: 'jobs.yield.v1', version: 1, window_hours: hours, known: false, launches: null, merged: null, reverted: null, empty: null, skipped: null,
    stop_slots: null, summary: 'Job yield: unknown (job metrics file unreadable)', families: [], stop_first: [] };
}

export function yieldVerdict(row: Omit<YieldRow, 'verdict'>): string {
  const parts = [`${row.name}: ${plural(row.prs, 'PR')} from ${plural(row.launches, 'launch', 'launches')}`, `${row.merged} merged`];
  if (row.reverted) parts.push(`${row.reverted} reverted`);
  parts.push(`${row.empty} empty`);
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
    reverted: runs.filter(r => r.reverted).length,
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

/**
 * jobs.jsonl field dialects, the same sets lane-yield-weight.computeLaneYield,
 * queue/job-outcomes.parseJobOutcomeRows, metrics/reward-feed and
 * metrics/loop.ledgerEvent accept: job ids take job|job_id|jobId|id, the event
 * name event|type|kind ('published' normalizes to 'publish'), the phase
 * state|outcome|status, timestamps ts|timestamp|at|time|mergedAt|closedAt|
 * recordedAt|updatedAt (mergedAt/closedAt preferred on terminal rows) and the
 * lane alias pool. Eventless rows carrying a resolved PR phase
 * (MERGED/CLOSED/OPEN) or PUBLISHED read as 'outcome'/'publish', the dispatchd
 * _vc_event convention — that is how metrics-outcomes reconciler rows
 * (`jobId`/`prUrl`/`outcome`/`status` + `source`) arrive.
 */
const JOB_KEYS = ['job', 'job_id', 'jobId', 'id'] as const;
const EVENT_KEYS = ['event', 'type', 'kind'] as const;
const PHASE_KEYS = ['state', 'outcome', 'status'] as const;
const LANE_KEYS = ['lane', 'pool'] as const;
const URL_KEYS = ['url', 'pr_url', 'prUrl', 'pr', 'html_url'] as const;
const TS_FIELDS = ['ts', 'timestamp', 'at', 'time', 'mergedAt', 'closedAt', 'recordedAt', 'updatedAt'] as const;
/** Skip events that prove the job never took a slot; `applied:false` is a dry run. */
const SKIP_EVENTS: ReadonlySet<string> = new Set(['precheck_skip', 'skipped_empty']);
/** Named events whose phase is a resolved job outcome. */
const OUTCOME_EVENTS: ReadonlySet<string> = new Set(['outcome', 'result', 'resolved', 'resolution']);
const RESOLVED_PHASES: ReadonlySet<string> = new Set(['MERGED', 'CLOSED', 'OPEN']);

const firstString = (row: Record<string, unknown>, keys: readonly string[]): string | null => {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
};
const phaseOf = (row: Record<string, unknown>): string => (firstString(row, PHASE_KEYS) ?? '').toUpperCase();

/** First parseable stamp among the ledger's timestamp fields; MERGED prefers mergedAt, CLOSED closedAt. */
const eventTs = (row: Record<string, unknown>, phase: string): number | null => {
  const preferred = phase === 'MERGED' ? 'mergedAt' : phase === 'CLOSED' ? 'closedAt' : null;
  const fields = preferred === null ? TS_FIELDS : [preferred, ...TS_FIELDS.filter(f => f !== preferred)];
  for (const field of fields) {
    const at = parseLedgerTs(row[field]);
    if (at !== null) return at;
  }
  return null;
};

/** Named lifecycle event, or the phase-inferred 'publish'/'outcome' for eventless rows. */
const ledgerEvent = (row: Record<string, unknown>, phase: string): string | null => {
  const named = firstString(row, EVENT_KEYS)?.toLowerCase() ?? null;
  if (named !== null) return named === 'published' ? 'publish' : named;
  if (phase === 'PUBLISHED') return 'publish';
  return RESOLVED_PHASES.has(phase) ? 'outcome' : null;
};

/**
 * The outcome state a row resolves its job to, or null when it carries none.
 * A resolved phase riding on a 'publish' event counts too: reconciler rows
 * copied from publish rows keep `event:'publish'`. `merged:true` and a 'merged'
 * event name are merge evidence on any post-launch row; an outcome row with no
 * phase records nothing rather than an unknown that would overwrite a merge.
 */
const outcomeState = (row: Record<string, unknown>, event: string | null, phase: string): string | null => {
  if (row['merged'] === true || event === 'merged') return 'MERGED';
  if (event !== null && OUTCOME_EVENTS.has(event)) return phase !== '' ? phase : null;
  if (event === 'publish' && RESOLVED_PHASES.has(phase)) return phase;
  return null;
};

/** Incremental tally so callers can stream a large ledger line by line. */
/** One launch as the tally sees it, after MERGED outcomes are credited. Read-only view for other reports. */
export type YieldRun = Readonly<Omit<Run, 'prs'>> & { readonly prs: ReadonlySet<string> };

export function yieldTally(now: number, hours: number): { add(line: string): void; report(): YieldReport; jobYield(): JobYieldReport; jobYieldParts(): JobYieldParts; runs(): YieldRun[] } {
  if (!Number.isFinite(hours) || hours <= 0) throw new RangeError('Hours must be positive.');
  const start = now - hours * 3_600_000;
  const byJob = new Map<string, Run[]>();
  const outcomes = new Map<string, string>();
  const revertedJobs = new Set<string>();
  const skips = new Map<string, { repo: string; rows: number }>();
  /** Credit each resolved job once. Safe to repeat. A recorded revert is never a held merge. */
  const settle = (): Run[] => {
    for (const [job, state] of outcomes) {
      const runs = byJob.get(job)!;
      const withPr = runs.filter(r => r.prs.size > 0);
      const run = withPr[withPr.length - 1] ?? runs[runs.length - 1]!;
      if (state === 'MERGED') {
        if (revertedJobs.has(job)) run.reverted = true; else run.merged = true;
      } else if (REVERT_OUTCOMES.has(state)) run.reverted = true;
    }
    return [...byJob.values()].flat();
  };
  return {
    add(line: string) {
      let row: Record<string, unknown>;
      try {
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return;
        row = value as Record<string, unknown>;
      } catch { return; }
      const job = word(firstString(row, JOB_KEYS));
      if (job === 'unknown') return;
      const phase = phaseOf(row);
      const event = ledgerEvent(row, phase);
      const at = eventTs(row, phase);
      // Rows from before the window cannot belong to a run launched inside it.
      if (at !== null && at < start) return;
      // Revert evidence is job-scoped and sticky, like the router outcome fold:
      // any row carrying it marks the job, whatever its event name.
      if (hasRevertEvidence(row)) revertedJobs.add(job);
      const runs = byJob.get(job);
      if (event === 'launch') {
        if (at === null || at > now) return;
        const run: Run = { job, lane: word(firstString(row, LANE_KEYS)), tier: word(row.tier), repo: word(row.repo), model: typeof row.model === 'string' && row.model.trim() ? row.model.trim().slice(0, 80) : null, at, last: at, finished: false, empty: false, aborted: false, wall: null, tokens: null, prs: new Set(), merged: false, reverted: false };
        if (runs) runs.push(run); else byJob.set(job, [run]);
        return;
      }
      if (event !== null && SKIP_EVENTS.has(event) && row['applied'] !== false) {
        // A skip takes no slot, so it counts with or without a launch; it needs a time inside the window.
        if (at === null || at > now) return;
        const skip = skips.get(job) ?? { repo: 'unknown', rows: 0 };
        if (skip.repo === 'unknown') skip.repo = word(row.repo);
        skip.rows++;
        skips.set(job, skip);
        return;
      }
      if (!runs) return; // launched before the window, or never seen launching
      const latest = runs[runs.length - 1]!;
      if (at !== null && at <= now && at > latest.last) latest.last = at;
      if (event === 'finish') {
        const run = runs.find(r => !r.finished);
        if (!run) return;
        run.finished = true;
        run.empty ||= row.empty === true;
        run.wall = count(row.wall_s);
        run.tokens = count(row.tokens_total);
      } else if (event === 'publish') {
        const run = runs[runs.length - 1]!, kind = word(row.class);
        // A publish row naming a PR url under any spelling is a PR claim; the
        // eventless PUBLISHED spelling carries `prUrl` and no `class` at all.
        const url = firstString(row, URL_KEYS);
        if (kind === 'pr' || (kind === 'unknown' && url !== null)) run.prs.add(url ?? `pr:${run.prs.size}`);
        else if (kind === 'empty') run.empty = true;
        else if (kind.startsWith('abort')) run.aborted = true;
      }
      const state = outcomeState(row, event, phase);
      if (state !== null) outcomes.set(job, state);
    },
    runs: settle,
    jobYield: () => jobYieldParts(settle(), skips, hours).report,
    jobYieldParts: () => jobYieldParts(settle(), skips, hours),
    report(): YieldReport {
      const runs = settle();
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

/** `phm jobs yield`: which job kinds are worth a launch slot. Pure; the caller passes the ledger lines. */
export function jobYield(lines: Iterable<string>, now: number, hours: number): JobYieldReport {
  const tally = yieldTally(now, hours);
  for (const line of lines) tally.add(line);
  return tally.jobYield();
}

export function unknownYield(hours: number): YieldReport {
  return { schema: 'fleet.yield.v1', window_hours: hours, known: false, launches: 0, families: [], lanes: [], tiers: [] };
}
