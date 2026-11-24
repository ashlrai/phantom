/**
 * landed-from-git.ts — which fleet jobs reached the default branch, read from plain git.
 *
 * gh cannot run on the host, so the self-tick never saw its own merges. This lists every job id
 * found in a commit subject on origin/<default branch> inside the window
 * (`bridge(RQ-...)`, or `RQ-...` in a squash title). One reader, no gh, no guessing:
 * a failed fetch or log is `ok: false` with a plain reason, never an empty "nothing landed".
 */
import { execFileSync } from 'node:child_process';

export const LANDED_GIT_SCHEMA = 'fleet.landed.v1';
export interface LandedJob { id: string; repo: string; sha: string; at: string }
export interface LandedRepoReading { repo: string; ok: boolean; jobs: number; reason?: string }
export interface LandedFromGit {
  schema: typeof LANDED_GIT_SCHEMA;
  source: 'git';
  /** True when at least one repo was read. */
  ok: boolean;
  /** The first (main) repo. */
  repo: string;
  sinceHours: number;
  /** Plain reason when ok is false. */
  reason?: string;
  jobs: LandedJob[];
  /** One reading per repo asked about, so a failure on one never hides the others. */
  repos: LandedRepoReading[];
}
export interface LandedRepo { name: string; cwd?: string }
export interface LandedFromGitOptions {
  sinceHours?: number;
  repo?: string;
  cwd?: string;
  /** Every repo to read; each is one checkout. Defaults to the single repo above. */
  repos?: LandedRepo[];
  now?: number;
  /** Test seam: run git with these args (and the repo's cwd), return stdout, throw on failure. */
  git?: (args: string[], cwd?: string) => string;
}

// Only subjects attribute landed jobs; bodies may mention superseded or related jobs.
const ID = /(?<![A-Za-z0-9_-])RQ-[A-Za-z0-9][A-Za-z0-9-]*/g;
const FIELD = '\x1f', RECORD = '\x1e';

const failure = (err: unknown): string => {
  const e = err as { stderr?: unknown; message?: unknown };
  const text = String(Buffer.isBuffer(e.stderr) ? e.stderr.toString() : e.stderr ?? e.message ?? 'unknown error');
  return text.split('\n').map(s => s.trim()).find(Boolean)?.slice(0, 160) ?? 'unknown error';
};

/** `owner/name` or a path becomes the short repo name, so reports say "phantom". */
export function landedReposFromEnv(env: string | undefined = process.env.ASHLR_LANDED_REPOS): LandedRepo[] {
  return (env ?? '').split(',').map(s => s.trim()).filter(Boolean).map(cwd => ({ name: cwd.replace(/\/+$/, '').split('/').pop() ?? cwd, cwd }));
}

/** Merged jobs on each repo's default branch in the window, oldest first; the oldest commit per id wins. */
export function readLandedFromGit(opts: LandedFromGitOptions = {}): LandedFromGit {
  const sinceHours = opts.sinceHours ?? 24;
  const repos: LandedRepo[] = opts.repos?.length ? opts.repos : [{ name: opts.repo ?? 'phantom', cwd: opts.cwd }];
  const sinceIso = new Date((opts.now ?? Date.now()) - sinceHours * 3_600_000).toISOString();
  const jobs: LandedJob[] = [];
  const readings: LandedRepoReading[] = [];
  for (const { name, cwd } of repos) {
    const git = (args: string[]): string => opts.git ? opts.git(args, cwd) : execFileSync('git', args, {
      cwd: cwd ?? opts.cwd ?? process.env.ASHLR_LANDED_REPO ?? process.cwd(), encoding: 'utf8', timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let branch = 'master';
    try {
      const head = git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).trim();
      if (head.startsWith('origin/')) branch = head.slice(7);
    } catch { /* master */ }
    let log: string;
    try {
      // A shallow checkout holds one commit, which is how a day of merges once counted as 1: deepen to the window.
      let shallow = false;
      try { shallow = git(['rev-parse', '--is-shallow-repository']).trim() === 'true'; } catch { /* not shallow */ }
      git(['fetch', '--quiet', ...(shallow ? [`--shallow-since=${sinceIso}`] : []), 'origin', branch]);
      log = git(['log', `origin/${branch}`, `--since=${sinceIso}`, `--format=%H${FIELD}%cI${FIELD}%s${RECORD}`]);
    } catch (err) {
      readings.push({ repo: name, ok: false, jobs: 0, reason: `git could not read origin/${branch} (${failure(err)})` });
      continue;
    }
    const found = new Map<string, LandedJob>();
    for (const rec of log.split(RECORD)) {
      const [sha = '', at = '', subject = ''] = rec.replace(/^\s+/, '').split(FIELD);
      if (!sha) continue;
      for (const raw of new Set(subject.match(ID) ?? [])) {
        const id = raw.replace(/-+$/, '');
        found.set(id, { id, repo: name, sha, at }); // log is newest first, so the last write is the oldest
      }
    }
    jobs.push(...found.values());
    readings.push({ repo: name, ok: true, jobs: found.size });
  }
  jobs.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  const ok = readings.some(r => r.ok);
  const reason = ok ? undefined : readings.map(r => repos.length > 1 ? `${r.repo}: ${r.reason}` : r.reason).join('; ');
  return {
    schema: LANDED_GIT_SCHEMA, source: 'git', ok, repo: repos[0]!.name, sinceHours,
    ...(reason === undefined ? {} : { reason }), jobs, repos: readings,
  };
}

/** First line, plain words: "68 jobs landed in the last 24 h: phantom 52, ashlr-md 6 (from git)." */
export function landedHeadline(r: LandedFromGit): string {
  if (!r.ok) return `Can't tell what landed on ${r.repos.length > 1 ? r.repos.map(x => x.repo).join(', ') : r.repo}: ${r.reason ?? 'git could not be read'}. Inspected 0.`;
  const n = r.jobs.length;
  const per = r.repos.filter(x => x.ok && x.jobs > 0).sort((a, b) => b.jobs - a.jobs).map(x => `${x.repo} ${x.jobs}`);
  const bad = r.repos.filter(x => !x.ok).map(x => `${x.repo} (${x.reason})`);
  return `${n} ${n === 1 ? 'job' : 'jobs'} landed in the last ${r.sinceHours} h${per.length ? `: ${per.join(', ')}` : ''} (from git).`
    + (bad.length ? ` Could not read ${bad.join(', ')}.` : '');
}
export const landedLine = (j: LandedJob): string => `${j.id} ${j.repo} ${j.sha.slice(0, 7)} ${j.at}`;

