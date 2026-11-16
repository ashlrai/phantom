/**
 * `phm fleet wt-census` — the full worktree census: every worktree under the
 * job root (~/Projects/ashlrai/wt) and the runs root (~/.ashlr-runs/wt),
 * classified SAFE-REAP / HOLD / UNKNOWN with measured size, owning repo,
 * last-commit date and age bucket.
 *
 * The census sits on top of `phm fleet wt-audit`'s evidence pass — the same
 * .base/.publish/.rc/.dispatched/.reaping markers, queue/keep.txt,
 * status.json, jobs.jsonl ledger, process table and kept-worktrees pins that
 * dispatchd and reap-one.sh act on — then adds the three checks the reap
 * spec asks for and the audit does not need:
 *
 *   repo          the worktree's `.git` pointer resolves its owning
 *                 repository (no subprocess: the gitdir path names it).
 *   lastCommitAt  `git -C <wt> log -1 --format=%ct HEAD`, bounded: one shared
 *                 deadline and a small worker pool; a slow tree reports null.
 *   dirty         `git -C <wt> status --porcelain` first-byte verdict, run
 *                 only for worktrees the fleet evidence already calls
 *                 reapable — any output is uncommitted work, a clean exit is
 *                 proof of clean, anything else is unproven.
 *
 * Classification (deliberately conservative):
 *
 *   safe-reap   the audit marks the worktree reapable, its state is merged,
 *               published or empty (a publish or merge is recorded — a
 *               'finished' worktree has no publish yet, so it waits for
 *               reap-one), the tree is provably clean and the disk-maint
 *               protect-list does not match its path.
 *   hold        positive keep evidence: running/in-flight, held, archived,
 *               an open or ended outcome, a recorded or finished-but-
 *               unpublished job, uncommitted work, a protect-list match, or
 *               a standing (invalid/excluded) folder.
 *   unknown     insufficient evidence — degraded sources, an orphaned or
 *               unreadable folder, or a reapable-looking tree whose dirty
 *               check could not complete. Unknown never counts as safe.
 *
 * READ-ONLY like the audit: the census never deletes, publishes or writes
 * queue state; `--apply` does not exist. Reaping stays with the sanctioned
 * tools named in each entry's `via`.
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Source } from './runs-parked-queue.js';
import {
  defaultFs as wtAuditDefaultFs, readWtAudit,
  type ReadWtAuditOptions, type WtAuditEntry, type WtAuditState, type WtReapVia,
} from './wt-audit.js';
import {
  protectedReason, protectedRoots, resolveMaintRoots, type MaintRoots,
} from '../disk-maint/protect.js';

const DAY_MS = 86_400_000;
/** One shared deadline for every git probe in a census run. */
const GIT_BUDGET_MS = 15_000;
const GIT_CONCURRENCY = 8;
const GIT_PROBE_TIMEOUT_MS = 5_000;
const TOP_DEFAULT = 20;
const TOP_MAX = 100;

export type WtCensusClass = 'safe-reap' | 'hold' | 'unknown';
export type WtCensusRoot = 'jobs' | 'runs';
export type WtAgeBucket = '<1d' | '1-7d' | '7-30d' | '30-90d' | '>90d' | 'unknown';

export const WT_CENSUS_AGE_BUCKETS: readonly WtAgeBucket[] = ['<1d', '1-7d', '7-30d', '30-90d', '>90d', 'unknown'];

/** States whose fleet evidence is a positive reason to keep the worktree. */
const HOLD_STATES = new Set<WtAuditState>([
  'running', 'reaping', 'publishing', 'held', 'archived', 'open', 'ended',
  'recorded', 'finished', 'invalid', 'excluded',
]);
/** States with a publish or merge already recorded — the only safe-reap states. */
const SAFE_STATES = new Set<WtAuditState>(['merged', 'published', 'empty']);
/** Standing folders a git probe would waste time on. */
const SKIP_GIT_STATES = new Set<WtAuditState>(['invalid', 'excluded']);

export interface WtCensusGit {
  /** HEAD last-commit epoch ms; null when unproven (unborn, non-git, timeout). */
  lastCommitMs(dir: string): Promise<number | null>;
  /** true when `status --porcelain` reports work; null when unproven. */
  dirty(dir: string): Promise<boolean | null>;
}

/* ---------------------------------------------------------------------- */
/* Pure helpers — exported for unit tests, no I/O.                          */
/* ---------------------------------------------------------------------- */

/** `.git` pointer `gitdir: <repo>/.git/worktrees/<name>` → the owning repo's
 * directory name; a submodule layout names the module. A plain `.git/` dir,
 * a bare repo or foreign layout → null. */
export function repoFromGitText(text: string | null): string | null {
  if (text === null) return null;
  const match = /^gitdir:[ \t]*(\S+)[ \t\r]*$/m.exec(text);
  if (!match) return null;
  const gitdir = match[1]!.replace(/\\/g, '/').replace(/\/+$/, '');
  const worktrees = /^(.*)\/\.git\/worktrees\/[^/]+$/.exec(gitdir);
  if (worktrees) return worktrees[1]!.split('/').filter(Boolean).pop() ?? null;
  const submodule = /\/\.git\/modules\/([^/]+)\/worktrees\/[^/]+$/.exec(gitdir);
  return submodule?.[1] ?? null;
}

export function ageBucketOf(ageHours: number | null): WtAgeBucket {
  if (ageHours === null) return 'unknown';
  const days = ageHours * 3_600_000 / DAY_MS;
  if (days < 1) return '<1d';
  if (days < 7) return '1-7d';
  if (days < 30) return '7-30d';
  if (days < 90) return '30-90d';
  return '>90d';
}

export interface WtCensusVerdict {
  census: WtCensusClass;
  /** Census-only blockers; the audit's own blocker list rides alongside. */
  blockers: string[];
}

/** The three-class verdict: an audit entry plus dirty and protect-list facts. */
export function censusClassify(input: {
  state: WtAuditState;
  reapable: boolean;
  protectedReason: string | null;
  dirty: boolean | null;
}): WtCensusVerdict {
  const blockers: string[] = [];
  let census: WtCensusClass;
  if (!input.reapable) {
    census = HOLD_STATES.has(input.state) ? 'hold' : 'unknown';
  } else if (input.state === 'finished') {
    // A finish is not a publish: reap-one.sh must run first, so the spec's
    // "publish recorded" gate keeps this out of safe-reap.
    blockers.push('publish-pending');
    census = 'hold';
  } else if (!SAFE_STATES.has(input.state)) {
    census = 'unknown';
  } else if (input.dirty === true) {
    blockers.push('uncommitted-changes');
    census = 'hold';
  } else if (input.dirty === null) {
    blockers.push('dirty-unproven');
    census = 'unknown';
  } else {
    census = 'safe-reap';
  }
  if (input.protectedReason !== null) {
    blockers.unshift(`protect-list:${input.protectedReason}`);
    census = 'hold';
  }
  return { census, blockers };
}

/* ---------------------------------------------------------------------- */
/* Git probes — bounded subprocesses, one shared deadline.                  */
/* ---------------------------------------------------------------------- */

/** `git -C dir log -1 --format=%ct HEAD` → epoch ms; null on any failure. */
function gitLastCommitMs(dir: string, timeoutMs: number): Promise<number | null> {
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('git', ['-C', dir, 'log', '-1', '--format=%ct', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { resolve(null); return; }
    let out = '';
    let settled = false;
    const finish = (value: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    child.stdout!.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    child.on('error', () => finish(null));
    child.on('close', code => {
      if (code !== 0) return finish(null);
      const sec = Number(out.trim());
      finish(Number.isSafeInteger(sec) && sec > 0 ? sec * 1000 : null);
    });
  });
}

/** `git status --porcelain` first-byte verdict: any output means dirty — so a
 * dirty tree answers on its first chunk and never floods the pipe — a clean
 * exit without output means clean, anything else is unproven. */
function gitDirty(dir: string, timeoutMs: number): Promise<boolean | null> {
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('git', ['-C', dir, 'status', '--porcelain', '--no-renames'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { resolve(null); return; }
    let settled = false;
    const finish = (value: boolean | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (value !== false) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    child.stdout!.on('data', () => finish(true));
    child.on('error', () => finish(null));
    child.on('close', code => finish(code === 0 ? false : null));
  });
}

/** Live probes clipped by the shared deadline; past it everything is unproven. */
function defaultGitProbe(deadlineMs: number): WtCensusGit {
  const left = (): number => Math.min(GIT_PROBE_TIMEOUT_MS, Math.max(0, deadlineMs - Date.now()));
  return {
    lastCommitMs: dir => (Date.now() >= deadlineMs ? Promise.resolve(null) : gitLastCommitMs(dir, left())),
    dirty: dir => (Date.now() >= deadlineMs ? Promise.resolve(null) : gitDirty(dir, left())),
  };
}

const NO_GIT: WtCensusGit = { lastCommitMs: async () => null, dirty: async () => null };

/** Small bounded worker pool — keeps git spawns at a sane concurrency. */
async function mapPool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  }));
}

/* ---------------------------------------------------------------------- */
/* Report.                                                                  */
/* ---------------------------------------------------------------------- */

export interface WtCensusEntry {
  name: string;
  root: WtCensusRoot;
  census: WtCensusClass;
  state: WtAuditState;
  /** Sanctioned reaper for the entry, as the audit computes it. */
  via: WtReapVia | null;
  pool: string | null;
  /** Owning repo directory name from the worktree's `.git` pointer. */
  repo: string | null;
  /** ISO timestamp of the worktree HEAD's last commit; null when unproven. */
  lastCommitAt: string | null;
  /** Uncommitted-work verdict; null when the probe did not run or failed. */
  dirty: boolean | null;
  /** queue/run/<job>.fin exists; null when the run listing was unreadable. */
  fin: boolean | null;
  bytes: number | null;
  sizeComplete: boolean;
  ageHours: number | null;
  ageBucket: WtAgeBucket;
  /** Audit blockers first, then census-only blockers. */
  blockers: string[];
}

export interface WtCensusGroup {
  worktrees: number;
  bytes: number;
  safeReap: number;
  safeReapBytes: number;
}

export interface WtCensusReport {
  schema: 'fleet.wt-census.v1';
  generatedAt: string;
  readOnly: true;
  roots: { worktrees: string; runsWorktrees: string; runs: string };
  sources: {
    worktrees: Source;
    runsWorktrees: Source;
    jobs: Source;
    runs: Source;
    queue: Source;
    keep: Source;
    run: Source;
    status: Source;
    ps: 'healthy' | 'unavailable';
    pins: 'valid' | 'invalid';
    /** skipped with --no-git, partial when the shared deadline clipped probes. */
    git: 'healthy' | 'skipped' | 'partial';
    sized: boolean;
  };
  worktrees: WtCensusEntry[];
  groups: {
    byCensus: Record<WtCensusClass, WtCensusGroup>;
    byState: Partial<Record<WtAuditState, number>>;
    byRepo: Array<{ repo: string } & WtCensusGroup>;
    byAge: Array<{ bucket: WtAgeBucket } & WtCensusGroup>;
  };
  totals: { worktrees: number; bytes: number | null; complete: boolean };
  safeReap: {
    count: number;
    /** Total bytes across every safe-reap entry; null when unsized. */
    bytes: number | null;
    complete: boolean;
    /** The largest safe-reap candidates, biggest first. */
    top: Array<{
      name: string; root: WtCensusRoot; repo: string | null; state: WtAuditState;
      via: WtReapVia | null; bytes: number | null; ageHours: number | null; lastCommitAt: string | null;
    }>;
  };
}

export interface WtCensusDeps extends ReadWtAuditOptions {
  /** HOME override for roots and the protect-list; default os.homedir(). */
  home?: string;
  maintRoots?: MaintRoots;
  /** Test hook; default is protectedReason under resolved maint roots. */
  protect?: (path: string) => string | null;
  /** Injectable git probe pair; default spawns bounded git subprocesses. */
  git?: WtCensusGit;
  /** false skips every git subprocess: dirty and lastCommit report null. */
  wantGit?: boolean;
  /** Shared deadline for all git probes; default 15 s. */
  gitBudgetMs?: number;
  gitConcurrency?: number;
  /** Size of the safe-reap top list; default 20, capped at 100. */
  top?: number;
}

const worseSource = (a: Source, b: Source): Source =>
  a === 'degraded' || b === 'degraded' ? 'degraded' : a === 'missing' || b === 'missing' ? 'missing' : 'healthy';

const emptyGroup = (): WtCensusGroup => ({ worktrees: 0, bytes: 0, safeReap: 0, safeReapBytes: 0 });

export async function readWtCensus(deps: WtCensusDeps = {}): Promise<WtCensusReport> {
  const now = deps.now ?? Date.now();
  const home = deps.home ?? homedir();
  const wtDir = deps.wtRoot ?? process.env['ASHLR_WT_DIR'] ?? join(home, 'Projects', 'ashlrai', 'wt');
  const runsDir = deps.runsRoot ?? process.env['ASHLR_RUNS_DIR'] ?? join(home, '.ashlr-runs');
  const runsWtDir = join(runsDir, 'wt');
  const runDir = join(runsDir, 'queue', 'run');
  const fs = deps.fs ?? wtAuditDefaultFs;
  const wantGit = deps.wantGit !== false;
  const top = Math.max(1, Math.min(TOP_MAX, Math.floor(deps.top ?? TOP_DEFAULT)));
  const concurrency = Math.max(1, Math.min(32, Math.floor(deps.gitConcurrency ?? GIT_CONCURRENCY)));

  const maintRoots = deps.maintRoots ?? resolveMaintRoots({ home, runsDir, wtDir });
  const protect = deps.protect ?? (() => {
    const list = protectedRoots(maintRoots);
    return (path: string) => protectedReason(path, maintRoots, list);
  })();

  // Two audit passes over the same evidence chain: the job root first (the
  // gate's 762 live there), then the runs root wt-reap owns.
  const jobsAudit = await readWtAudit({ ...deps, wtRoot: wtDir, runsRoot: runsDir });
  const runsAudit = await readWtAudit({ ...deps, wtRoot: runsWtDir, runsRoot: runsDir });
  const audits: Array<{ root: WtCensusRoot; report: typeof jobsAudit }> = [
    { root: 'jobs', report: jobsAudit },
    { root: 'runs', report: runsAudit },
  ];

  const runEntries = await fs.entries(runDir);
  const fins = runEntries === null ? null
    : new Set(runEntries.filter(e => e.endsWith('.fin')).map(e => e.slice(0, -'.fin'.length)));

  interface Raw { root: WtCensusRoot; dir: string; audit: WtAuditEntry }
  const raws: Raw[] = audits.flatMap(a =>
    a.report.worktrees.map(audit => ({ root: a.root, dir: join(a.report.wtDir, audit.name), audit })));

  const deadlineMs = Date.now() + (deps.gitBudgetMs ?? GIT_BUDGET_MS);
  const git = wantGit ? (deps.git ?? defaultGitProbe(deadlineMs)) : NO_GIT;

  const protectedByDir = new Map<string, string | null>();
  const repoByDir = new Map<string, string | null>();
  const dirtyByDir = new Map<string, boolean | null>();
  const commitByDir = new Map<string, number | null>();

  // Repo names come off each worktree's .git pointer — file reads, no git.
  await mapPool(raws, concurrency, async raw => {
    protectedByDir.set(raw.dir, protect(raw.dir));
    repoByDir.set(raw.dir, repoFromGitText(await fs.text(join(raw.dir, '.git'))));
  });

  let probesPlanned = 0;
  let probesDone = 0;
  if (wantGit) {
    // Dirty checks decide the class, so they run first: only worktrees the
    // fleet evidence already calls reapable in a safe state get probed.
    const dirtyTargets = raws.filter(raw =>
      raw.audit.reapable && SAFE_STATES.has(raw.audit.state) && protectedByDir.get(raw.dir) === null);
    const commitTargets = raws.filter(raw => !SKIP_GIT_STATES.has(raw.audit.state));
    probesPlanned = dirtyTargets.length + commitTargets.length;
    const probe = async (run: () => Promise<void>): Promise<void> => {
      // Past the shared deadline a probe is skipped entirely — that is what
      // makes the source 'partial', not an attempted probe that returned null.
      if (Date.now() >= deadlineMs) return;
      await run();
      probesDone++;
    };
    await mapPool(dirtyTargets, concurrency, async raw =>
      probe(async () => { dirtyByDir.set(raw.dir, await git.dirty(raw.dir)); }));
    await mapPool(commitTargets, concurrency, async raw =>
      probe(async () => { commitByDir.set(raw.dir, await git.lastCommitMs(raw.dir)); }));
  }

  const worktrees: WtCensusEntry[] = raws.map(raw => {
    const dirty = dirtyByDir.get(raw.dir) ?? null;
    const verdict = censusClassify({
      state: raw.audit.state,
      reapable: raw.audit.reapable,
      protectedReason: protectedByDir.get(raw.dir) ?? null,
      dirty,
    });
    const commitMs = commitByDir.get(raw.dir) ?? null;
    return {
      name: raw.audit.name,
      root: raw.root,
      census: verdict.census,
      state: raw.audit.state,
      via: raw.audit.via,
      pool: raw.audit.pool,
      repo: repoByDir.get(raw.dir) ?? null,
      lastCommitAt: commitMs === null ? null : new Date(commitMs).toISOString(),
      dirty,
      fin: fins === null ? null : fins.has(raw.audit.name),
      bytes: raw.audit.bytes,
      sizeComplete: raw.audit.sizeComplete,
      ageHours: raw.audit.ageHours,
      ageBucket: ageBucketOf(raw.audit.ageHours),
      blockers: [...raw.audit.blockers, ...verdict.blockers],
    };
  });

  const byCensus: Record<WtCensusClass, WtCensusGroup> = {
    'safe-reap': emptyGroup(), hold: emptyGroup(), unknown: emptyGroup(),
  };
  const byState: Partial<Record<WtAuditState, number>> = {};
  const byRepo = new Map<string, WtCensusGroup>();
  const byAge = new Map<WtAgeBucket, WtCensusGroup>(WT_CENSUS_AGE_BUCKETS.map(b => [b, emptyGroup()]));
  for (const w of worktrees) {
    const bytes = w.bytes ?? 0;
    const safe = w.census === 'safe-reap';
    const repo = w.repo ?? 'unknown';
    if (!byRepo.has(repo)) byRepo.set(repo, emptyGroup());
    for (const group of [byCensus[w.census], byRepo.get(repo)!, byAge.get(w.ageBucket)!]) {
      group.worktrees++;
      group.bytes += bytes;
      if (safe) { group.safeReap++; group.safeReapBytes += bytes; }
    }
    byState[w.state] = (byState[w.state] ?? 0) + 1;
  }
  const repoGroups = [...byRepo.entries()]
    .map(([repo, g]) => ({ repo, ...g }))
    .sort((a, b) => b.bytes - a.bytes || a.repo.localeCompare(b.repo));
  const ageGroups = WT_CENSUS_AGE_BUCKETS.map(bucket => ({ bucket, ...byAge.get(bucket)! }));

  const safe = worktrees.filter(w => w.census === 'safe-reap')
    .sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1) || a.name.localeCompare(b.name));

  return {
    schema: 'fleet.wt-census.v1',
    generatedAt: new Date(now).toISOString(),
    readOnly: true,
    roots: { worktrees: wtDir, runsWorktrees: runsWtDir, runs: runsDir },
    sources: {
      worktrees: jobsAudit.sources.worktrees,
      runsWorktrees: runsAudit.sources.worktrees,
      jobs: worseSource(jobsAudit.sources.jobs, runsAudit.sources.jobs),
      runs: worseSource(jobsAudit.sources.runs, runsAudit.sources.runs),
      queue: worseSource(jobsAudit.sources.queue, runsAudit.sources.queue),
      keep: worseSource(jobsAudit.sources.keep, runsAudit.sources.keep),
      run: worseSource(jobsAudit.sources.run, runsAudit.sources.run),
      status: worseSource(jobsAudit.sources.status, runsAudit.sources.status),
      ps: jobsAudit.sources.ps === 'unavailable' || runsAudit.sources.ps === 'unavailable' ? 'unavailable' : 'healthy',
      pins: jobsAudit.sources.pins === 'valid' && runsAudit.sources.pins === 'valid' ? 'valid' : 'invalid',
      git: !wantGit ? 'skipped' : probesDone < probesPlanned ? 'partial' : 'healthy',
      sized: jobsAudit.sources.sized && runsAudit.sources.sized,
    },
    worktrees,
    groups: { byCensus, byState, byRepo: repoGroups, byAge: ageGroups },
    totals: {
      worktrees: worktrees.length,
      bytes: jobsAudit.totals.bytes === null || runsAudit.totals.bytes === null ? null
        : jobsAudit.totals.bytes + runsAudit.totals.bytes,
      complete: jobsAudit.totals.complete && runsAudit.totals.complete,
    },
    safeReap: {
      count: safe.length,
      // null when any safe-reap entry is unsized — a partial total is worse
      // than an honest unknown.
      bytes: safe.every(w => w.bytes !== null)
        ? safe.reduce((sum, w) => sum + (w.bytes ?? 0), 0) : null,
      complete: safe.every(w => w.bytes !== null),
      top: safe.slice(0, top).map(w => ({
        name: w.name, root: w.root, repo: w.repo, state: w.state, via: w.via,
        bytes: w.bytes, ageHours: w.ageHours, lastCommitAt: w.lastCommitAt,
      })),
    },
  };
}

/* ---------------------------------------------------------------------- */
/* Human formatting — pure.                                                */
/* ---------------------------------------------------------------------- */

const round1 = (n: number): number => Math.round(n * 10) / 10;

function formatGb(bytes: number | null): string {
  if (bytes === null) return 'unknown';
  const gb = round1(bytes / 1e9);
  return `${gb === 0 && bytes > 0 ? '<0.1' : gb} GB`;
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

export function formatWtCensus(report: WtCensusReport): string[] {
  const lines = ['wt census — reads only, deletes nothing'];
  const { byCensus, byRepo, byAge, byState } = report.groups;
  lines.push(`worktrees: ${report.totals.worktrees} (${formatGb(report.totals.bytes)})`
    + ` — ${report.roots.worktrees} + ${report.roots.runsWorktrees}`);
  lines.push(`census: ${byCensus['safe-reap'].worktrees} safe-reap (${formatGb(byCensus['safe-reap'].bytes)})`
    + ` · ${byCensus.hold.worktrees} hold · ${byCensus.unknown.worktrees} unknown`);
  const states = Object.entries(byState).sort((a, b) => b[1] - a[1]);
  if (states.length) lines.push(`states: ${states.map(([s, n]) => `${n} ${s}`).join(', ')}`);
  if (byRepo.length) {
    lines.push(`by repo: ${byRepo.slice(0, 12).map(g =>
      `${g.repo} ${g.worktrees}/${formatGb(g.bytes)}${g.safeReap ? ` (${g.safeReap} safe)` : ''}`).join(', ')}`
      + (byRepo.length > 12 ? `, +${byRepo.length - 12} more` : ''));
  }
  lines.push(`by age: ${byAge.filter(g => g.worktrees > 0 || g.bucket === 'unknown')
    .map(g => `${g.bucket} ${g.worktrees}`).join(' · ')}`);
  const { safeReap } = report;
  if (safeReap.count === 0) {
    lines.push('safe to reap now: nothing proven safe (unknown never counts)');
  } else {
    lines.push(`safe to reap now: ${plural(safeReap.count, 'worktree')}, ${formatGb(safeReap.bytes)}`
      + `${safeReap.complete ? '' : ' (partial sizes)'} — top ${safeReap.top.length}:`);
    for (const w of safeReap.top) {
      lines.push(`  ${w.name} [${w.repo ?? 'unknown'}]: ${formatGb(w.bytes)} — ${w.state}, ${w.via ?? 'manual'},`
        + ` ${w.ageHours === null ? 'age unknown' : `${w.ageHours}h ago`}, last commit ${w.lastCommitAt ?? 'unknown'}`);
    }
    lines.push('reapers: reap-one = ~/.ashlr-runs/bin/reap-one.sh <job>; worktree-remove = git worktree remove'
      + ' (fleet worktree-stale --apply / wt-reap --apply).');
  }
  const degraded = Object.entries(report.sources)
    .filter(([key, v]) => !['sized', 'git'].includes(key) && (v === 'degraded' || v === 'unavailable' || v === 'invalid'));
  if (degraded.length) {
    lines.push(`degraded sources: ${degraded.map(([k, v]) => `${k}=${v}`).join(', ')} — unproven worktrees are never safe`);
  }
  if (report.sources.git === 'partial') lines.push('git probes hit the shared deadline — unprobed worktrees are not proven safe');
  if (report.sources.git === 'skipped') lines.push('git probes skipped (--no-git) — safe-reap candidates stay unknown');
  return lines;
}
