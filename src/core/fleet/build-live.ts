/**
 * build-live.ts — `phm doctor build`: is the phm that runs on this host the same code the fleet merged?
 *
 * Merged self-improvement only goes live when the host's phm is rebuilt from master. A host running a
 * checkout hundreds of commits back looks healthy and silently runs none of it. This reads, and never writes:
 *   - the commit: embedded at build time (dist/build-identity.json) when present, else `git rev-parse HEAD`
 *     of the directory phm runs from;
 *   - the branch: `git symbolic-ref` of that directory (detached head is its own answer);
 *   - how far behind master: `git rev-list --count <commit>..origin/master` against the LOCAL fetch ref.
 *     By default it never fetches, pulls, checks out or rebuilds, so a host that never fetches reads
 *     "current" while master moves. `fetch: true` (`--fetch`) opts in to refreshing that one remote-tracking
 *     ref first (`git fetch origin master`); it still never touches the checkout, and a failed fetch is
 *     reported, not hidden.
 * Anything it cannot tell is "unknown" with the reason; nothing is guessed.
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readBuildIdentity } from '../build-identity.js';
import { readLastBuild, type LastBuild } from './build-last.js';

export const BUILD_LIVE_SCHEMA = 'doctor.build.v1';
/** Local refs tried in order; the first that exists is "master". No network. */
const MASTER_REFS = ['origin/master', 'origin/main'] as const;
const GIT_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 30_000;

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
  /** Freshness of the master ref `behind` was counted against: 'local' = whatever was last fetched (may be
   *  stale), 'fetched' = refreshed just now, 'fetch-failed' = a fetch was asked for and failed (local ref used). */
  refFreshness?: 'local' | 'fetched' | 'fetch-failed';
  /** The host's last rebuild (leader/phm-live-state.txt); absent when no path was given. */
  lastBuild?: LastBuild;
  verdict: string;
}

/** Runs git in a directory; returns trimmed stdout, or null when git fails or is missing. Test seam. */
export type GitRunner = (cwd: string, args: string[], timeoutMs?: number) => string | null;

const defaultGit: GitRunner = (cwd, args, timeoutMs = GIT_TIMEOUT_MS) => {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'],
      // Never block on a credential prompt: a fetch that needs one fails and is reported.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
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
  /** Path of leader/phm-live-state.txt; when set, the report carries the last rebuild's result. */
  liveStatePath?: string;
  /** Refresh the remote-tracking master ref from origin before counting. Default false: no network. */
  fetch?: boolean;
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

  let refState: BuildLiveReport['refFreshness'] = 'local';
  if (opts.fetch && isCheckout) {
    // Only the remote-tracking ref moves; HEAD, the index and the working tree are untouched.
    const ok = ['master', 'main'].some(b => git(codeDir, ['fetch', '--quiet', '--no-tags', 'origin', b], FETCH_TIMEOUT_MS) !== null);
    refState = ok ? 'fetched' : 'fetch-failed';
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

  const report = { schema: BUILD_LIVE_SCHEMA, generatedAt: new Date(now).toISOString(), codeDir, commit, branch, behind, refFreshness: refState } as BuildLiveReport;
  if (opts.liveStatePath) report.lastBuild = readLastBuild(opts.liveStatePath);
  report.verdict = buildVerdict(report);
  return report;
}

function buildVerdict(r: Pick<BuildLiveReport, 'commit' | 'branch' | 'behind' | 'refFreshness'>): string {
  const v = verdictCore(r);
  return r.refFreshness === 'fetch-failed' ? `${v}; fetching origin failed, so this used the local ref, which may be stale` : v;
}

function verdictCore(r: Pick<BuildLiveReport, 'commit' | 'branch' | 'behind'>): string {
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
