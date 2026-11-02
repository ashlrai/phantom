/**
 * outside-prs.ts — open PRs on fleet repos that are NOT fleet work.
 *
 * The fleet only sees its own `codex-bridge/*` branches, so an outside PR
 * touching files a running job is rewriting surfaces at merge time as a
 * DIRTY PR. This lists, per distinct repo among running jobs (plus the
 * workspace repo), open PRs whose head is not `codex-bridge/*` and whose
 * author is not the fleet App, each with its touched paths and collisions.
 *
 * Sources (read-only, never throws): the dispatchd `claimed` projection
 * (runs-dir-state.ts); each job's `.base` worktree resolved to `owner/name`
 * by repo-identity.ts (no URL or worktree path ever leaves); job changes via
 * getFleetJobChanges; `gh pr list`/`gh pr view --json files` spawned exactly
 * like core/verse/github-repo.ts (no shell, array args, colourless env).
 *
 * `gh` absent → 'missing' with an empty list, never a throw. Unreadable
 * claimed sets, repos or PR files → 'degraded' — "no collisions" is never
 * reported for work nobody could check. Cached like github-repo.ts's lists:
 * fresh for RESULT_FRESH_MS, then stale while ONE background refresh runs;
 * injected runners always run live.
 */
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { credentialExecFile as execFile } from '../integrations/secrets.js';
import { scrubSecrets } from '../util/scrub.js';
import { getFleetJobChanges, type FleetJobChangesV1 } from './runs-job-changes.js';
import { readFleetRunsDirState } from './runs-dir-state.js';
import { isFleetJobId } from './runs-job-detail.js';
import { repoIdentityOfPath } from './repo-identity.js';

const GH_BIN = 'gh';
const GH_TIMEOUT_MS = 15_000;
const MAX_REPOS = 10;
const MAX_JOBS = 50;
const MAX_PRS_PER_REPO = 20;
const MAX_PR_FILES = 200;
const MAX_OVERLAP_PATHS = 50;
const MAX_JSON_CHARS = 512 * 1024;
const MAX_TEXT_CHARS = 256;
const MAX_PATH_CHARS = 512;

const FLEET_BRANCH_PREFIX = 'codex-bridge/';
/** The fleet App's logins — host-merge.ts FLEET_APP_BOT_LOGIN plus gh's `app/<name>` spelling. */
const FLEET_BOT_LOGINS = new Set(['ashlr-fleet[bot]', 'app/ashlr-fleet']);
const NAME_WITH_OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const PR_LIST_FIELDS = 'number,title,author,headRefName,updatedAt';

export interface OutsidePrOverlap { job: string; paths: string[] }
export interface OutsidePrV1 {
  number: number; title: string; author: string; head: string; updatedAt: string | null;
  files: string[]; overlaps: OutsidePrOverlap[];
}
export interface OutsidePrsRepoV1 { repo: string; state: 'healthy' | 'degraded'; prs: OutsidePrV1[] }
export interface OutsidePrsV1 {
  v: 1; generatedAt: string; sourceState: 'healthy' | 'missing' | 'degraded'; repos: OutsidePrsRepoV1[];
}

/** Run `gh` in `cwd`; trimmed stdout, or null on ANY failure. github-repo.ts's runner contract. */
export type OutsidePrsGhRunner = (cwd: string, args: readonly string[]) => Promise<string | null> | string | null;

export interface ListOutsidePrsOptions {
  /** Runs directory. Default ASHLR_RUNS_DIR, then `~/.ashlr-runs`. */
  runsDir?: string;
  homeDir?: string;
  /** The workspace checkout also scanned for outside PRs. Default process.cwd(). */
  workspaceDir?: string;
  gh?: OutsidePrsGhRunner;
  /** Running fleet job ids. Default: dispatchd's claimed set (runs-dir-state.ts). */
  runningJobs?: () => Promise<readonly string[]> | readonly string[];
  /** A job's repo checkout. Default: the worktree in `<job>.base`, verified inside the home. */
  jobWorktree?: (job: string) => Promise<string | null>;
  /** A job's changed paths. Default: getFleetJobChanges. */
  jobChanges?: (job: string) => Promise<FleetJobChangesV1>;
  /** Checkout path → `owner/name`. Default: repo-identity.ts. */
  repoIdentity?: (path: string) => string | null;
  now?: () => Date;
}

/** Same spawn shape as github-repo.ts's realGhAsync: no shell, array args, tight timeout. */
const realGh: OutsidePrsGhRunner = (cwd, args) =>
  new Promise((resolveOut) => {
    try {
      execFile(GH_BIN, [...args], {
        cwd, timeout: GH_TIMEOUT_MS, encoding: 'utf8', maxBuffer: MAX_JSON_CHARS * 2, windowsHide: true,
        env: { ...process.env, GH_HOST: 'github.com', GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
      }, (err, stdout) => resolveOut(err || typeof stdout !== 'string' ? null : stdout.trim()));
    } catch {
      resolveOut(null);
    }
  });

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function safeJson(raw: string | null): unknown {
  if (!raw || raw.length > MAX_JSON_CHARS) return null;
  try { return JSON.parse(raw) as unknown; } catch { return null; }
}

/** Free text bounded + scrubbed for the wire; null when there is nothing usable. */
function text(value: unknown, max = MAX_TEXT_CHARS): string | null {
  if (typeof value !== 'string') return null;
  const clean = scrubSecrets(value.trim());
  return clean.length === 0 || clean.length > max ? null : clean;
}

/** gh nests author as `{ login }`; a ghost author is null. */
function authorLogin(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 128);
  return isRecord(value) && typeof value['login'] === 'string' ? value['login'].slice(0, 128) : '';
}

function isoTime(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** A repo-relative git path — gh should only ever emit these, but nothing else leaves. */
const safeRelPath = (p: string) =>
  p !== '' && p.length <= MAX_PATH_CHARS && !p.startsWith('/') && !p.includes('\0') && !p.split('/').includes('..');

function repoLabel(value: string | null): string | null {
  if (value === null) return null;
  const clean = scrubSecrets(value);
  return NAME_WITH_OWNER.test(clean) ? clean : null;
}

interface RawPr { number: number; title: string; author: string; head: string; updatedAt: string | null }

/** Parse `gh pr list --json <PR_LIST_FIELDS>`; malformed entries are dropped, not defaulted. */
function parsePrList(parsed: unknown): RawPr[] {
  if (!Array.isArray(parsed)) return [];
  const out: RawPr[] = [];
  for (const raw of parsed.slice(0, MAX_PRS_PER_REPO)) {
    if (!isRecord(raw)) continue;
    const n = typeof raw['number'] === 'number' && Number.isSafeInteger(raw['number']) && raw['number'] > 0 ? raw['number'] : null;
    const title = text(raw['title']);
    const head = text(raw['headRefName']);
    if (n === null || title === null || head === null) continue;
    out.push({ number: n, title, author: scrubSecrets(authorLogin(raw['author'])), head, updatedAt: isoTime(raw['updatedAt']) });
  }
  return out;
}

/** Parse `gh pr view --json files` → repo-relative paths. null when gh's shape is unrecognised. */
function parsePrFiles(parsed: unknown): string[] | null {
  if (!isRecord(parsed) || !Array.isArray(parsed['files'])) return null;
  const out: string[] = [];
  for (const entry of parsed['files']) {
    const path = isRecord(entry) ? text(entry['path'], MAX_PATH_CHARS) : null;
    if (path !== null && safeRelPath(path)) out.push(path);
    if (out.length >= MAX_PR_FILES) break;
  }
  return out;
}

const inside = (home: string, path: string) => {
  const rel = relative(home, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/**
 * The worktree a job's `.base` names — the same file, parse and home-bound
 * checks as runs-job-changes.ts (which deliberately never lets the path
 * leave). It leaves here only as `owner/name`, never as a path.
 */
async function readJobWorktree(job: string, runsDir: string, home: string): Promise<string | null> {
  try {
    if (!isFleetJobId(job)) return null;
    if (!(await lstat(join(runsDir, `${job}.base`))).isFile()) return null;
    const handle = await open(join(runsDir, `${job}.base`), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const buffer = Buffer.alloc(16 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const fields = /^\s*(\S+)\s+\S+\s+(.+?)\r?$/.exec(
        buffer.toString('utf8', 0, bytesRead).split('\n').find((line) => line.trim() !== '') ?? '');
      const worktree = fields?.[2] ?? '';
      if (!isAbsolute(worktree)) return null;
      const resolved = resolve(worktree);
      if (!inside(home, resolved) || !(await lstat(resolved)).isDirectory()) return null;
      if (!inside(await realpath(home), await realpath(resolved))) return null;
      return resolved;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** Running job ids from the dispatchd projection; 'degraded' claimed means the set may be partial. */
async function defaultRunningJobs(runsDir: string): Promise<{ jobs: string[]; degraded: boolean }> {
  const state = await readFleetRunsDirState({ runsDir });
  return { jobs: state.claimed.map((c) => c.job), degraded: state.sources.claimed === 'degraded' };
}

async function mapConcurrent<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length) as R[];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }));
  return out;
}

/**
 * Open PRs on the repos running fleet jobs touch (plus the workspace repo)
 * that are not fleet work, each collided against the running jobs' changed
 * paths. Never throws and emits no path, URL, token or hostname — repos
 * leave as `owner/name` only.
 */
async function computeOutsidePrs(opts: ListOutsidePrsOptions): Promise<OutsidePrsV1> {
  const gh = opts.gh ?? realGh;
  const home = opts.homeDir ?? homedir();
  const runsDir = opts.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(home, '.ashlr-runs');
  const workspaceDir = opts.workspaceDir ?? process.cwd();
  const result: OutsidePrsV1 = { v: 1, generatedAt: (opts.now ?? (() => new Date()))().toISOString(), sourceState: 'healthy', repos: [] };
  const degrade = () => { if (result.sourceState === 'healthy') result.sourceState = 'degraded'; };

  // `gh --version` needs no auth and no network: a null answer means the
  // binary itself is absent, and the whole read is honestly 'missing'.
  if ((await gh(workspaceDir, ['--version'])) === null) {
    result.sourceState = 'missing';
    return result;
  }

  let jobs: string[] = [];
  try {
    const found = opts.runningJobs ? { jobs: [...await opts.runningJobs()], degraded: false } : await defaultRunningJobs(runsDir);
    if (found.degraded) degrade();
    jobs = [...new Set(found.jobs.filter(isFleetJobId))].slice(0, MAX_JOBS);
  } catch {
    degrade();
  }

  const identityOf = (path: string): string | null => {
    try { return repoLabel((opts.repoIdentity ?? repoIdentityOfPath)(path)); } catch { return null; }
  };
  const jobWorktree = opts.jobWorktree ?? ((job: string) => readJobWorktree(job, runsDir, home));
  const jobRepo = new Map<string, string>();
  const repoCwds = new Map<string, string>();
  for (const job of jobs) {
    const worktree = await jobWorktree(job).catch(() => null);
    const repo = worktree === null ? null : identityOf(worktree);
    if (repo === null) continue;
    jobRepo.set(job, repo);
    if (!repoCwds.has(repo)) repoCwds.set(repo, worktree!);
  }
  const workspaceRepo = identityOf(workspaceDir);
  if (workspaceRepo !== null && !repoCwds.has(workspaceRepo)) repoCwds.set(workspaceRepo, workspaceDir);
  if (repoCwds.size > MAX_REPOS) degrade();

  const jobChanges = opts.jobChanges ?? ((job: string) => getFleetJobChanges(job, { runsDir, homeDir: home }));
  const changedByJob = new Map<string, { paths: string[]; degraded: boolean }>();
  const changesFor = async (job: string) => {
    const hit = changedByJob.get(job);
    if (hit) return hit;
    let entry: { paths: string[]; degraded: boolean };
    try {
      const changes = await jobChanges(job);
      entry = { paths: changes.files.map((f) => f.path), degraded: changes.state === 'degraded' };
    } catch {
      entry = { paths: [], degraded: true };
    }
    changedByJob.set(job, entry);
    return entry;
  };

  result.repos = await mapConcurrent([...repoCwds.entries()].slice(0, MAX_REPOS), 4, async ([repo, cwd]) => {
    let repoDegraded = false;
    const listed = safeJson(await gh(cwd, ['pr', 'list', '--state', 'open', '--limit', String(MAX_PRS_PER_REPO), '--json', PR_LIST_FIELDS]));
    if (!Array.isArray(listed)) return { repo, state: 'degraded' as const, prs: [] };
    const outside = parsePrList(listed).filter(
      (pr) => !pr.head.startsWith(FLEET_BRANCH_PREFIX) && !FLEET_BOT_LOGINS.has(pr.author.toLowerCase()));
    const jobsHere = jobs.filter((job) => jobRepo.get(job) === repo);
    const prs: OutsidePrV1[] = await mapConcurrent(outside, 4, async (pr) => {
      const files = parsePrFiles(safeJson(await gh(cwd, ['pr', 'view', String(pr.number), '--json', 'files'])));
      const overlaps: OutsidePrOverlap[] = [];
      if (files === null) {
        repoDegraded = true;
      } else {
        const touched = new Set(files);
        for (const job of jobsHere) {
          const changes = await changesFor(job);
          if (changes.degraded) repoDegraded = true;
          const paths = [...new Set(changes.paths.filter((p) => touched.has(p)))].sort().slice(0, MAX_OVERLAP_PATHS);
          if (paths.length > 0) overlaps.push({ job, paths });
        }
      }
      return { number: pr.number, title: pr.title, author: pr.author, head: pr.head, updatedAt: pr.updatedAt, files: files ?? [], overlaps };
    });
    return { repo, state: repoDegraded ? ('degraded' as const) : ('healthy' as const), prs };
  });
  if (result.repos.some((repo) => repo.state === 'degraded')) degrade();
  return result;
}

// ---------------------------------------------------------------------------
// Cache — github-repo.ts's list semantics at whole-result level
// ---------------------------------------------------------------------------

const RESULT_FRESH_MS = 60_000;
const RESULT_MAX_STALE_MS = 10 * 60_000;
let resultCache: { key: string; at: number; value: OutsidePrsV1 } | null = null;
let resultInFlight: Promise<OutsidePrsV1> | null = null;

/** Test hook: drop the result cache and any in-flight reference. */
export function resetOutsidePrsForTest(): void {
  resultCache = null;
  resultInFlight = null;
}

function refresh(opts: ListOutsidePrsOptions, key: string): Promise<OutsidePrsV1> {
  if (resultInFlight) return resultInFlight;
  resultInFlight = computeOutsidePrs(opts)
    .then((value) => {
      resultCache = { key, at: Date.now(), value };
      return value;
    })
    .finally(() => {
      resultInFlight = null;
    });
  return resultInFlight;
}

/**
 * Cached entry point: production reads share one 60 s-fresh result and one
 * in-flight refresh; a call carrying injected seams always computes live so
 * tests see their own runners, never another caller's cache.
 */
export function listOutsidePrs(opts: ListOutsidePrsOptions = {}): Promise<OutsidePrsV1> {
  const live =
    opts.gh !== undefined || opts.runningJobs !== undefined || opts.jobWorktree !== undefined ||
    opts.jobChanges !== undefined || opts.repoIdentity !== undefined || opts.now !== undefined;
  if (live) return computeOutsidePrs(opts);
  const key = JSON.stringify([opts.runsDir ?? '', opts.homeDir ?? '', opts.workspaceDir ?? '']);
  const hit = resultCache;
  if (hit && hit.key === key) {
    const age = Date.now() - hit.at;
    if (age < RESULT_FRESH_MS) return Promise.resolve(hit.value);
    if (age < RESULT_MAX_STALE_MS) {
      void refresh(opts, key).catch(() => undefined);
      return Promise.resolve(hit.value);
    }
  }
  return refresh(opts, key);
}
