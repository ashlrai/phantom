/** Offline PR evidence from the locally available default branch; never fetches. */
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scrubSecrets } from '../util/scrub.js';

export interface MergedPrFeed {
  source: { kind: 'git'; repoRoot: string; ref: string | null };
  since: string; until: string;
  state: 'ok' | 'incomplete' | 'unavailable';
  reason: string | null;
  prs: Array<{ number: number; sha: string; mergedAt: string; title: string }>;
}

/** Commit time is local merge evidence, not an independently verified GitHub timestamp. */
export function readMergedPrFeed(options: { repoRoot?: string; now?: number; since?: number } = {}): MergedPrFeed {
  const repoRoot = options.repoRoot ?? join(homedir(), 'Projects', 'ashlrai', 'phantom');
  const now = options.now ?? Date.now(), since = options.since ?? now - 86_400_000;
  const result: MergedPrFeed = { source: { kind: 'git', repoRoot, ref: null },
    since: new Date(since).toISOString(), until: new Date(now).toISOString(), state: 'unavailable', reason: null, prs: [] };
  const git = (args: string[]) => execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  try {
    let ref: string;
    try { ref = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']); }
    catch {
      // Never use a topic checkout's HEAD as evidence of a merge.
      ref = ['refs/heads/master', 'refs/heads/main'].find(candidate => {
        try { git(['rev-parse', '--verify', candidate]); return true; } catch { return false; }
      }) ?? '';
    }
    if (!ref) { result.reason = 'No local default-branch ref'; return result; }
    result.source.ref = ref;
    const shallow = git(['rev-parse', '--is-shallow-repository']) === 'true';
    const log = git(['log', ref, '--first-parent', `--since-as-filter=${result.since}`, `--until=${result.until}`,
      '--format=%H%x1f%cI%x1f%s%x1e', '--']);
    const seen = new Set<number>();
    for (const record of log.split('\x1e')) {
      const [sha, mergedAt, subject] = record.trim().split('\x1f');
      if (!sha || !mergedAt || !subject) continue;
      const match = subject.match(/^Merge pull request #(\d+)\b/) ?? subject.match(/\(#(\d+)\)$/);
      const number = Number(match?.[1]), time = Date.parse(mergedAt);
      if (!Number.isSafeInteger(number) || number <= 0 || time < since || time > now || !Number.isFinite(time) || seen.has(number)) continue;
      seen.add(number);
      result.prs.push({ number, sha, mergedAt: new Date(time).toISOString(), title: scrubSecrets(subject).replace(/\s+/g, ' ').slice(0, 300) });
    }
    result.prs.sort((a, b) => b.mergedAt.localeCompare(a.mergedAt) || b.number - a.number);
    result.state = shallow ? 'incomplete' : 'ok';
    result.reason = shallow ? 'Shallow local history; the 24-hour window may be incomplete' : null;
  } catch { result.reason = 'Local default-branch history could not be read'; }
  return result;
}
