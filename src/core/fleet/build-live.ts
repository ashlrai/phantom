/**
 * build-live.ts — `phm doctor build`: is the phm that runs on this host the same code the fleet merged?
 *
 * Merged self-improvement only goes live when the host's phm is rebuilt from master. A host running a
 * checkout hundreds of commits back looks healthy and silently runs none of it. This reads, and never writes:
 *   - the commit: embedded at build time (dist/build-identity.json) when present, else `git rev-parse HEAD`
 *     of the directory phm runs from;
 *   - the branch: `git symbolic-ref` of that directory (detached head is its own answer);
 *   - how far behind master: `git rev-list --count <commit>..origin/master` against the LOCAL fetch ref.
 *     It never fetches, pulls, checks out or rebuilds.
 * Anything it cannot tell is "unknown" with the reason; nothing is guessed.
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readBuildIdentity } from '../build-identity.js';

export const BUILD_LIVE_SCHEMA = 'doctor.build.v1';
/** Local refs tried in order; the first that exists is "master". No network. */
const MASTER_REFS = ['origin/master', 'origin/main'] as const;
const GIT_TIMEOUT_MS = 10_000;

type Known<T> = { state: 'known' } & T;
type Unknown = { state: 'unknown'; why: string };

export interface BuildLiveReport {
  schema: typeof BUILD_LIVE_SCHEMA;
  generatedAt: string;
  /** The directory phm runs from (the package root). */
  codeDir: string;
  /** Where the commit came from: 'build' = embedded at build time, 'git' = HEAD of codeDir. */
  commit: Known<{ sha: string; source: 'build' | 'git' }> | Unknown;
  /** Branch name; 'detached' for a detached head. */
  branch: Known<{ name: string | 'detached' }> | Unknown;
  /** `since`: when the oldest commit the running build lacks was merged (ISO), null when git would not say. */
  behind: Known<{ count: number; ref: string; since: string | null }> | Unknown;
  verdict: string;
}

/** Runs git in a directory; returns trimmed stdout, or null when git fails or is missing. Test seam. */
export type GitRunner = (cwd: string, args: string[]) => string | null;

const defaultGit: GitRunner = (cwd, args) => {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }).trim();
  } catch { return null; }
};

export interface BuildLiveOptions {
  /** The directory phm runs from. Defaults to this package's root. */
  codeDir?: string;
  now?: () => number;
  git?: GitRunner;
  /** The build-time commit; null = none embedded. Defaults to dist/build-identity.json. */
  readBuiltSha?: () => string | null;
}

const defaultCodeDir = (): string => fileURLToPath(new URL('../../../', import.meta.url));
const defaultBuiltSha = (): string | null => readBuildIdentity().revision;
const short = (sha: string): string => sha.slice(0, 7);
const same = (a: string, b: string): boolean => { try { return realpathSync(a) === realpathSync(b); } catch { return false; } };

export function readBuildLive(opts: BuildLiveOptions = {}): BuildLiveReport {
  const codeDir = opts.codeDir ?? defaultCodeDir();
  const git = opts.git ?? defaultGit;
  const now = (opts.now ?? Date.now)();
  const built = (opts.readBuiltSha ?? defaultBuiltSha)();

  // A directory only counts as a checkout when git's top level IS it; a package installed inside some
  // other project must not report that project's history as its own.
  const top = git(codeDir, ['rev-parse', '--show-toplevel']);
  const isCheckout = top !== null && top !== '' && same(top, codeDir);
  const notGit = 'not a git checkout';

  let commit: BuildLiveReport['commit'];
  if (built) commit = { state: 'known', sha: built, source: 'build' };
  else if (!isCheckout) commit = { state: 'unknown', why: `no commit embedded at build time and ${codeDir} is ${notGit}` };
  else {
    const head = git(codeDir, ['rev-parse', '--verify', 'HEAD']);
    commit = head ? { state: 'known', sha: head, source: 'git' } : { state: 'unknown', why: 'git could not read HEAD' };
  }

  let branch: BuildLiveReport['branch'];
  if (!isCheckout) branch = { state: 'unknown', why: notGit };
  else {
    const name = git(codeDir, ['symbolic-ref', '--short', '-q', 'HEAD']);
    branch = { state: 'known', name: name || 'detached' };
  }

  let behind: BuildLiveReport['behind'];
  if (commit.state === 'unknown') behind = { state: 'unknown', why: 'the running commit is unknown' };
  else if (!isCheckout) behind = { state: 'unknown', why: notGit };
  else {
    const ref = MASTER_REFS.find(r => git(codeDir, ['rev-parse', '--verify', '-q', `${r}^{commit}`]));
    if (!ref) behind = { state: 'unknown', why: 'no local origin/master ref (nothing fetched yet)' };
    else {
      const raw = git(codeDir, ['rev-list', '--count', `${commit.sha}..${ref}`]);
      const count = raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
      if (count === null) behind = { state: 'unknown', why: `${short(commit.sha)} is not in this checkout's history` };
      else {
        const oldest = count > 0 ? git(codeDir, ['log', '--reverse', '--format=%cI', `${commit.sha}..${ref}`])?.split('\n')[0] : null;
        const since = oldest && Number.isFinite(Date.parse(oldest)) ? new Date(oldest).toISOString() : null;
        behind = { state: 'known', count, ref, since };
      }
    }
  }

  const report = { schema: BUILD_LIVE_SCHEMA, generatedAt: new Date(now).toISOString(), codeDir, commit, branch, behind } as BuildLiveReport;
  report.verdict = buildVerdict(report);
  return report;
}

function buildVerdict(r: Pick<BuildLiveReport, 'commit' | 'branch' | 'behind'>): string {
  if (r.commit.state === 'unknown') return `live build is unknown: ${r.commit.why}`;
  const on = r.branch.state === 'known' ? (r.branch.name === 'detached' ? ' on a detached head' : ` on ${r.branch.name}`) : '';
  if (r.behind.state === 'unknown') return `live build is ${short(r.commit.sha)}${on}; how far behind master is unknown (${r.behind.why})`;
  const n = r.behind.count;
  if (n === 0) return `live build is up to date with master (${short(r.commit.sha)}${on})`;
  return `live build is ${n} ${n === 1 ? 'commit' : 'commits'} behind master${on}; merged fleet features may not be running`;
}

/** Plain words: the verdict, then the commit line. */
export function buildLiveLines(r: BuildLiveReport): string[] {
  const lines = [r.verdict];
  if (r.commit.state === 'known') lines.push(`  commit ${short(r.commit.sha)} (${r.commit.source === 'build' ? 'embedded at build time' : `HEAD of ${r.codeDir}`})`);
  return lines;
}
