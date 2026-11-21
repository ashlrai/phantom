/**
 * landed-from-git.ts — which fleet jobs reached the default branch, read from plain git.
 *
 * gh cannot run on the host, so the self-tick never saw its own merges. This lists every job id
 * found in a commit subject or body on origin/<default branch> inside the window
 * (`bridge(RQ-...)`, or `RQ-...` in a squash title). One reader, no gh, no guessing:
 * a failed fetch or log is `ok: false` with a plain reason, never an empty "nothing landed".
 */
import { execFileSync } from 'node:child_process';

export const LANDED_GIT_SCHEMA = 'fleet.landed.v1';
export interface LandedJob { id: string; repo: string; sha: string; at: string }
export interface LandedFromGit {
  schema: typeof LANDED_GIT_SCHEMA;
  source: 'git';
  ok: boolean;
  repo: string;
  sinceHours: number;
  /** Plain reason when ok is false. */
  reason?: string;
  jobs: LandedJob[];
}
export interface LandedFromGitOptions {
  sinceHours?: number;
  repo?: string;
  cwd?: string;
  now?: number;
  /** Test seam: run git with these args, return stdout, throw on failure. */
  git?: (args: string[]) => string;
}

const ID = /(?<![A-Za-z0-9_-])RQ-[A-Za-z0-9][A-Za-z0-9-]*/g;
const FIELD = '\x1f', RECORD = '\x1e';

const failure = (err: unknown): string => {
  const e = err as { stderr?: unknown; message?: unknown };
  const text = String(Buffer.isBuffer(e.stderr) ? e.stderr.toString() : e.stderr ?? e.message ?? 'unknown error');
  return text.split('\n').map(s => s.trim()).find(Boolean)?.slice(0, 160) ?? 'unknown error';
};

/** Newest-first merged jobs on the default branch in the window; the oldest commit per id wins. */
export function readLandedFromGit(opts: LandedFromGitOptions = {}): LandedFromGit {
  const sinceHours = opts.sinceHours ?? 24;
  const repo = opts.repo ?? 'phantom';
  const out = (ok: boolean, jobs: LandedJob[], reason?: string): LandedFromGit =>
    ({ schema: LANDED_GIT_SCHEMA, source: 'git', ok, repo, sinceHours, ...(reason === undefined ? {} : { reason }), jobs });
  const git = opts.git ?? ((args: string[]) => execFileSync('git', args, {
    cwd: opts.cwd ?? process.env.ASHLR_LANDED_REPO ?? process.cwd(), encoding: 'utf8', timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }));
  let branch: string;
  try {
    const head = git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).trim();
    branch = head.startsWith('origin/') ? head.slice(7) : 'master';
  } catch { branch = 'master'; }
  let log: string;
  try {
    git(['fetch', '--quiet', 'origin', branch]);
    const since = new Date((opts.now ?? Date.now()) - sinceHours * 3_600_000).toISOString();
    log = git(['log', `origin/${branch}`, `--since=${since}`, `--format=%H${FIELD}%cI${FIELD}%B${RECORD}`]);
  } catch (err) { return out(false, [], `git could not read origin/${branch} (${failure(err)})`); }
  const found = new Map<string, LandedJob>();
  for (const rec of log.split(RECORD)) {
    const [sha = '', at = '', ...body] = rec.replace(/^\s+/, '').split(FIELD);
    if (!sha) continue;
    for (const id of new Set(body.join(FIELD).match(ID) ?? [])) found.set(id, { id, repo, sha, at }); // log is newest first, so the last write is the oldest
  }
  return out(true, [...found.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)));
}

/** First line, plain words: "41 jobs landed on phantom in the last 24 h (from git)." */
export function landedHeadline(r: LandedFromGit): string {
  if (!r.ok) return `Can't tell what landed on ${r.repo}: ${r.reason ?? 'git could not be read'}. Inspected 0.`;
  return `${r.jobs.length} ${r.jobs.length === 1 ? 'job' : 'jobs'} landed on ${r.repo} in the last ${r.sinceHours} h (from git).`;
}
export const landedLine = (j: LandedJob): string => `${j.id} ${j.repo} ${j.sha.slice(0, 7)} ${j.at}`;
