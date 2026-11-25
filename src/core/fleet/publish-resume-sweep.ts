/**
 * `phm publish sweep` and the fleet self-tick stage: finish publishes that
 * pushed their fork branch and then stopped before `gh pr create` ran
 * (`RESULT ABORT pr`, a killed publish with no RESULT line, and the older
 * abort spellings). The local `<job>.publish` log is the evidence; each
 * candidate goes through `resumePublish`, which re-verifies the branch, the
 * existing PRs and the compare live before opening anything.
 *
 * The sweep never arms auto-merge (`armAutoMerge: false`): publish.sh skips
 * arming for sensitive paths and the publish log does not record which paths
 * a job touched, so the sweep cannot prove a branch is safe to arm. The
 * opened PR joins the ordinary queue instead — the merge-queue cycle's own
 * gated path (`securityPinnedPath` → pinned, eligible → head-pinned arm)
 * decides arming exactly as it does for every other PR.
 *
 * Bounded per pass (default 3, hard cap 10), oldest strand first, with a
 * small state file (`queue/publish-resume.json`) so a terminal or deferred
 * outcome is not re-attempted every tick. `default-fetch` aborts belong to
 * the stranded-requeue recovery job and `integrated-receipt-consume` to the
 * integrated-mode journal; both are reported under `skipped`, never resumed
 * here. A dry run scans and reports only: no GitHub calls, no state write.
 */
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { defaultGh, type Gh } from '../autopilot/github.js';
import { PUBLISH_REPOS, resumePublish } from '../publish/resume.js';
import type { RetryOptions } from '../publish/retry.js';
import { PUBLISH_LOG_NAME, readPublishLogLines } from './publish-log.js';

export const PUBLISH_RESUME_SWEEP_SCHEMA = 'publish.resume-sweep.v1';
export const PUBLISH_RESUME_DEFAULT_LIMIT = 3;
export const PUBLISH_RESUME_MAX_LIMIT = 10;
export const PUBLISH_RESUME_SINCE_HOURS = 48;
/** How long a deferred/error outcome waits before the sweep tries the branch again. */
export const PUBLISH_RESUME_RETRY_MS = 30 * 60_000;
/** How long a terminal outcome (opened, already-*, missing) is remembered. */
const STATE_TTL_MS = 7 * 24 * 3_600_000;
const STATE_FILE = 'publish-resume.json';

const RESULT_LINE = /^(?:RESULT\s|ABORT\b)/;
const ABORT_LINE = /^(?:RESULT )?ABORT(?:\s+(.*?))?\s*$/;
const PR_LINE = /^RESULT PR /;
/** The `pull/new/<branch>` link inside git's push hint carries the fork owner and repo name. */
const PULL_NEW = /github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/new\/(codex-bridge\/[A-Za-z0-9._-]+)(?=\s|$)/;
/** Abort reasons owned by other recovery machinery; the sweep reports them, never resumes them. */
const EXCLUDED_REASONS: Record<string, string> = {
  'default-fetch': 'fetch-race-requeue',
  'integrated-receipt-consume': 'integrated-mode',
};
/** Outcomes that need no further sweep attempts while the state entry is fresh. */
const TERMINAL = new Set(['opened', 'already-open', 'already-merged', 'already-on-main', 'missing']);

export interface PublishStrand {
  job: string;
  branch: string;
  /** Bare upstream repo name from the push-hint link (`phantom`); always allowlisted. */
  repo: string;
  /** Abort reason from the log, or `no-result` when the publish was killed before any RESULT line. */
  reason: string;
  /** Hours since the log was last written. */
  ageHours: number;
}
export interface SweepSkipped { job: string; why: string }
export interface SweepOutcome {
  job: string;
  branch: string;
  repo: string;
  status: string;
  pr_url: string | null;
  error?: string;
}
export interface PublishResumeSweepReport {
  schema: typeof PUBLISH_RESUME_SWEEP_SCHEMA;
  apply: boolean;
  generatedAt: string;
  sinceHours: number;
  limit: number;
  /** `unknown` when any publish log could not be read; those jobs are listed in `unreadable`, never counted as clean. */
  status: 'ok' | 'unknown';
  /** Publish logs read successfully. */
  scanned: number;
  /** Logs whose push was followed by `RESULT PR`: already published, nothing to do. */
  published: number;
  /** Resumable strands found before the per-pass limit and state dedupe. */
  candidates: number;
  /** Dry-run rows: the strands the next applied pass would attempt, oldest first. */
  planned: SweepOutcome[];
  /** Apply rows: what `resumePublish` answered for each attempted strand. */
  resumed: SweepOutcome[];
  skipped: SweepSkipped[];
  /** Strands held back this pass: over the limit, or inside the retry backoff. */
  deferred: SweepSkipped[];
  unreadable: string[];
  stateRead: 'ok' | 'unreadable';
  stateWrite: 'ok' | 'failed' | 'skipped';
  /** Only when the runs dir itself could not be scanned: plain reason, everything else empty. */
  reason?: string;
}

interface ScanResult {
  scanned: number;
  published: number;
  strands: PublishStrand[];
  skipped: SweepSkipped[];
  unreadable: string[];
}

/** Last index of a line, or -1. */
function lastIndexOf(lines: string[], test: (line: string) => boolean): number {
  for (let i = lines.length - 1; i >= 0; i--) if (test(lines[i]!)) return i;
  return -1;
}

function pushHintIndex(lines: string[], branch: string): number {
  return lastIndexOf(lines, (line) => line.trim().replace(/^remote:\s*/, '').startsWith(`Create a pull request for '${branch}'`));
}

/** Bare repo name + branch check from the push-hint link near `from`; null pieces stay honest. */
function pushLink(lines: string[], from: number, job: string): { repo: string | null; why: string | null } {
  for (const line of lines.slice(from, from + 8)) {
    const m = PULL_NEW.exec(line);
    if (!m) continue;
    if (m[3] !== `codex-bridge/${job}`) return { repo: null, why: 'link-mismatch' };
    const repo = m[2]!;
    if (!(PUBLISH_REPOS as readonly string[]).includes(repo)) return { repo: null, why: 'repo-not-allowlisted' };
    return { repo, why: null };
  }
  return { repo: null, why: 'no-push-link' };
}

/** Classify one publish log: pushed-then-stranded, pushed-then-published, or not a candidate. Read-only. */
async function classify(runsDir: string, name: string, now: number, sinceHours: number): Promise<
  { kind: 'strand'; strand: PublishStrand } | { kind: 'published' } | { kind: 'skip'; why: string } | { kind: 'unreadable' }
> {
  const job = name.slice(0, -'.publish'.length), branch = `codex-bridge/${job}`;
  let lines: string[];
  try { lines = await readPublishLogLines(runsDir, name); } catch { return { kind: 'unreadable' }; }
  const pushed = pushHintIndex(lines, branch);
  if (pushed < 0) return { kind: 'skip', why: 'no-push' };
  const after = lines.slice(pushed + 1);
  if (after.some((line) => PR_LINE.test(line))) return { kind: 'published' };
  const lastResult = lastIndexOf(after, (line) => RESULT_LINE.test(line));
  let reason = 'no-result';
  if (lastResult >= 0) {
    const abort = ABORT_LINE.exec(after[lastResult]!);
    if (!abort) return { kind: 'skip', why: 'other-result' };
    reason = abort[1] || 'unknown';
  }
  const excluded = EXCLUDED_REASONS[reason];
  if (excluded) return { kind: 'skip', why: excluded };
  // resumePublish's branch shape: codex-bridge/<1-80 of [A-Za-z0-9._-], no '..'>.
  if (job.length > 80 || job.includes('..')) return { kind: 'skip', why: 'bad-job-name' };
  const mtime = (await stat(join(runsDir, name))).mtimeMs;
  const ageHours = Math.max(0, Math.round((now - mtime) / 360000) / 10);
  if (ageHours > sinceHours) return { kind: 'skip', why: 'too-old' };
  const link = pushLink(lines, pushed, job);
  if (link.why !== null || link.repo === null) return { kind: 'skip', why: link.why ?? 'no-push-link' };
  return { kind: 'strand', strand: { job, branch, repo: link.repo, reason, ageHours } };
}

/** Scan `<runsDir>/*.publish` for a confirmed push with no `RESULT PR` afterwards. Oldest strand first. */
export async function scanPublishStrands(runsDir: string, opts: { sinceHours?: number; now?: number } = {}): Promise<ScanResult> {
  const now = opts.now ?? Date.now(), sinceHours = opts.sinceHours ?? PUBLISH_RESUME_SINCE_HOURS;
  const result: ScanResult = { scanned: 0, published: 0, strands: [], skipped: [], unreadable: [] };
  for (const name of (await readdir(runsDir)).sort()) {
    if (!PUBLISH_LOG_NAME.test(name) || name.includes('..')) continue;
    const job = name.slice(0, -'.publish'.length);
    const c = await classify(runsDir, name, now, sinceHours).catch(() => ({ kind: 'unreadable' as const }));
    if (c.kind === 'unreadable') { result.unreadable.push(job); continue; }
    result.scanned++;
    if (c.kind === 'published') result.published++;
    else if (c.kind === 'strand') result.strands.push(c.strand);
    else if (c.why !== 'no-push') result.skipped.push({ job, why: c.why });
  }
  result.strands.sort((a, b) => b.ageHours - a.ageHours || a.job.localeCompare(b.job));
  result.skipped.sort((a, b) => a.job.localeCompare(b.job));
  return result;
}

interface StateEntry { at: string; status: string }
interface SweepState { v: 1; branches: Record<string, StateEntry> }

const statePath = (runsDir: string): string => join(runsDir, 'queue', STATE_FILE);

async function readSweepState(runsDir: string): Promise<{ state: SweepState; ok: boolean }> {
  const empty: SweepState = { v: 1, branches: {} };
  let raw: unknown;
  try { raw = JSON.parse(await readFile(statePath(runsDir), 'utf8')); }
  catch (error) {
    return { state: empty, ok: (error as NodeJS.ErrnoException).code === 'ENOENT' };
  }
  const branches = (raw as Record<string, unknown> | null)?.['branches'];
  if ((raw as Record<string, unknown> | null)?.['v'] !== 1 || typeof branches !== 'object' || branches === null) {
    return { state: empty, ok: false };
  }
  const clean: Record<string, StateEntry> = {};
  for (const [key, value] of Object.entries(branches as Record<string, unknown>)) {
    const entry = value as Record<string, unknown> | null;
    if (typeof entry?.['at'] === 'string' && typeof entry?.['status'] === 'string') {
      clean[key] = { at: entry['at'], status: entry['status'] };
    }
  }
  return { state: { v: 1, branches: clean }, ok: true };
}

async function writeSweepState(runsDir: string, state: SweepState, now: number): Promise<boolean> {
  const fresh = Object.fromEntries(Object.entries(state.branches)
    .filter(([, entry]) => now - Date.parse(entry.at) < STATE_TTL_MS));
  try {
    const path = statePath(runsDir);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ v: 1, branches: fresh })}\n`, { mode: 0o600 });
    await rename(tmp, path);
    return true;
  } catch { return false; }
}

export interface SweepPublishResumesOptions {
  runsDir: string;
  /** False (default) scans and reports only: no GitHub calls, no state write. */
  apply?: boolean;
  /** Resumes attempted this pass, oldest strand first. Default 3, clamped to 10. */
  limit?: number;
  /** Candidate window in hours. Default 48. */
  sinceHours?: number;
  /** Clock seam for tests; ms epoch. */
  now?: () => number;
  /** `gh` seam for tests; production uses the real authed `gh`. */
  gh?: Gh;
  /** Read-retry seam forwarded to each `resumePublish` call; tests inject a no-op sleep. */
  retry?: RetryOptions;
}

/** One bounded pass over the local publish logs: open (never arm) a PR for each stranded publish, up to `limit`. */
export async function sweepPublishResumes(opts: SweepPublishResumesOptions): Promise<PublishResumeSweepReport> {
  const apply = opts.apply === true;
  const now = opts.now ?? Date.now;
  const at = now();
  const sinceRaw = opts.sinceHours ?? PUBLISH_RESUME_SINCE_HOURS;
  const sinceHours = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : PUBLISH_RESUME_SINCE_HOURS;
  const limitRaw = Math.floor(opts.limit ?? PUBLISH_RESUME_DEFAULT_LIMIT);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(PUBLISH_RESUME_MAX_LIMIT, limitRaw)) : PUBLISH_RESUME_DEFAULT_LIMIT;
  let scan: ScanResult;
  try {
    scan = await scanPublishStrands(opts.runsDir, { sinceHours, now: at });
  } catch {
    return {
      schema: PUBLISH_RESUME_SWEEP_SCHEMA, apply, generatedAt: new Date(at).toISOString(),
      sinceHours, limit, status: 'unknown', scanned: 0, published: 0, candidates: 0,
      planned: [], resumed: [], skipped: [], deferred: [], unreadable: [],
      stateRead: 'unreadable', stateWrite: 'skipped', reason: 'Publish directory is unreadable.',
    };
  }
  const { state, ok: stateOk } = await readSweepState(opts.runsDir);
  const report: PublishResumeSweepReport = {
    schema: PUBLISH_RESUME_SWEEP_SCHEMA, apply, generatedAt: new Date(at).toISOString(),
    sinceHours, limit, status: scan.unreadable.length ? 'unknown' : 'ok',
    scanned: scan.scanned, published: scan.published, candidates: scan.strands.length,
    planned: [], resumed: [], skipped: scan.skipped, deferred: [], unreadable: scan.unreadable,
    stateRead: stateOk ? 'ok' : 'unreadable', stateWrite: 'skipped',
  };
  let attempts = 0, wrote = false;
  for (const strand of scan.strands) {
    const key = `${strand.repo}:${strand.branch}`;
    const entry = state.branches[key];
    if (entry) {
      const age = at - Date.parse(entry.at);
      if (TERMINAL.has(entry.status) && age < STATE_TTL_MS) { report.skipped.push({ job: strand.job, why: 'already-recorded' }); continue; }
      if (!TERMINAL.has(entry.status) && age < PUBLISH_RESUME_RETRY_MS) { report.deferred.push({ job: strand.job, why: 'backoff' }); continue; }
    }
    if (attempts >= limit) { report.deferred.push({ job: strand.job, why: 'over-limit' }); continue; }
    attempts++;
    const row: SweepOutcome = { job: strand.job, branch: strand.branch, repo: strand.repo, status: 'planned', pr_url: null };
    if (!apply) { report.planned.push(row); continue; }
    try {
      const r = await resumePublish({ branch: strand.branch, repo: strand.repo, armAutoMerge: false, retry: opts.retry }, opts.gh ?? defaultGh);
      row.status = r.status; row.pr_url = r.pr_url;
      if (r.status === 'deferred' && r.deferred) row.error = r.deferred.reason;
    } catch (error) {
      row.status = 'error';
      row.error = (error instanceof Error ? error.message : 'resume failed').slice(0, 200);
    }
    state.branches[key] = { at: new Date(at).toISOString(), status: row.status };
    wrote = true;
    report.resumed.push(row);
  }
  if (apply && wrote) report.stateWrite = (await writeSweepState(opts.runsDir, state, at)) ? 'ok' : 'failed';
  report.skipped.sort((a, b) => a.job.localeCompare(b.job));
  return report;
}
