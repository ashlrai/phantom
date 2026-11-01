/** Read-only, bounded worktree changes for the worker log pane. */
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { defaultGitRunner, parseNumstatZ, parsePorcelainV2, type GitRunner } from '../verse/git-ops.js';
import { fleetEditRefusals } from './collision-free-edits.js';
import { isFleetJobId } from './runs-job-detail.js';

export interface FleetJobChangesV1 {
  schema: 'fleet.job.changes.v1';
  generatedAt: string;
  job: string;
  state: 'live' | 'missing' | 'degraded';
  baseSha: string | null;
  /** Present when tracked changes were compared against HEAD instead of the recorded base. */
  comparisonBase?: 'HEAD';
  files: Array<{ path: string; added: number | null; removed: number | null; status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' }>;
  totals: { files: number; added: number; removed: number };
  truncated: boolean;
  /** Changed paths the fleet admission rule refuses (singletons, agent guides, lockfiles). */
  refusals: { path: string; rule: string }[];
}
export interface FleetJobChangesOptions {
  runsDir?: string;
  homeDir?: string;
  runner?: GitRunner;
}
const cache = new Map<string, { until: number; value: Promise<FleetJobChangesV1> }>();
const safePath = (path: string) => path !== '' && !path.startsWith('/') && !path.includes('\0') && !path.split('/').includes('..');
const inside = (home: string, path: string) => { const rel = relative(home, path); return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };

export function getFleetJobChanges(job: string, opts: FleetJobChangesOptions = {}): Promise<FleetJobChangesV1> {
  if (!isFleetJobId(job)) throw new Error('invalid fleet job id');
  const home = opts.homeDir ?? homedir();
  const runs = opts.runsDir ?? join(home, '.ashlr-runs');
  if (!isAbsolute(runs) || !isAbsolute(home)) throw new Error('absolute directories required');
  // Test runners have their own identity; production polls share a cache and in-flight work.
  const key = JSON.stringify([home, runs, job]);
  const cached = !opts.runner && cache.get(key);
  if (cached && cached.until > Date.now()) return cached.value;
  const value = project(job, runs, home, opts.runner ?? defaultGitRunner);
  if (!opts.runner) {
    for (const [id, entry] of cache) if (entry.until <= Date.now()) cache.delete(id);
    const entry = { until: Number.POSITIVE_INFINITY, value };
    cache.set(key, entry);
    void value.then(() => { entry.until = Date.now() + 3_000; }, () => { cache.delete(key); });
  }
  return value;
}
async function project(job: string, runs: string, home: string, runner: GitRunner): Promise<FleetJobChangesV1> {
  const result: FleetJobChangesV1 = { schema: 'fleet.job.changes.v1', generatedAt: new Date().toISOString(), job, state: 'missing', baseSha: null, files: [], totals: { files: 0, added: 0, removed: 0 }, truncated: false, refusals: [] };
  let worktree: string;
  try {
    const path = join(runs, `${job}.base`);
    if (!(await lstat(path)).isFile()) return result;
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let text: string;
    try { const buffer = Buffer.alloc(16 * 1024); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); text = buffer.toString('utf8', 0, bytesRead); }
    finally { await handle.close(); }
    // The launcher records two whitespace-delimited tokens followed by the
    // full worktree path, which can itself contain whitespace.
    const fields = /^\s*(\S+)\s+\S+\s+(.+?)\r?$/.exec(text.split('\n').find(line => line.trim() !== '') ?? '');
    worktree = fields?.[2] ?? '';
    if (!isAbsolute(worktree)) return result;
    worktree = resolve(worktree); // trailing slashes must not make lstat follow a symlink
    if (!inside(home, worktree) || !(await lstat(worktree)).isDirectory()) return result;
    // Also exclude escapes through symlinked ancestor directories.
    if (!inside(await realpath(home), await realpath(worktree))) return result;
    const sha = fields?.[1] ?? '';
    result.baseSha = /^[0-9a-f]{7,64}$/.test(sha) ? sha : null;
  } catch { return result; }
  result.state = 'live';
  try {
    // defaultGitRunner supplies gitChildEnv(), including GIT_OPTIONAL_LOCKS=0.
    const options = { cwd: worktree, timeoutMs: 5_000, maxStdoutBytes: 1024 * 1024 };
    const [baseDiff, status] = await Promise.all([
      runner('git', ['diff', '--numstat', '-z', result.baseSha ?? 'HEAD'], options),
      runner('git', ['status', '--porcelain=v2', '-z', '--untracked-files=all'], options),
    ]);
    let diff = baseDiff;
    // Only an unavailable recorded object warrants a second comparison. Never
    // retry resource failures or expose Git's stderr to the caller.
    if (result.baseSha && diff.code !== null && diff.code !== 0 && !diff.timedOut && !diff.missing && !diff.truncated &&
      (diff.stderr.trim() === `fatal: bad object ${result.baseSha}` || diff.stderr.trim() === `fatal: bad revision '${result.baseSha}'`)) {
      result.state = 'degraded';
      diff = await runner('git', ['diff', '--numstat', '-z', 'HEAD'], options);
      if (diff.code === 0 && !diff.timedOut && !diff.missing && !diff.truncated) result.comparisonBase = 'HEAD';
    }
    result.truncated = diff.truncated || status.truncated;
    if ([diff, status].some(out => out.code !== 0 || out.timedOut || out.missing || out.truncated)) result.state = 'degraded';
    const changed = parsePorcelainV2(status.code === 0 ? status.stdout : '').changed;
    const statuses = new Map(changed.map(file => [file.path, file]));
    if (diff.code === 0) for (const entry of parseNumstatZ(diff.stdout)) {
      if (!safePath(entry.path)) continue;
      const status = statuses.get(entry.path)?.status;
      result.files.push({ path: entry.path, added: entry.binary ? null : entry.additions, removed: entry.binary ? null : entry.deletions,
        status: entry.oldPath || status === 'R' ? 'renamed' : status === 'A' ? 'added' : status === 'D' ? 'deleted' : 'modified' });
    }
    for (const file of changed) if (file.untracked && safePath(file.path)) result.files.push({ path: file.path, added: null, removed: null, status: 'untracked' });
    result.truncated ||= result.files.length > 200;
    result.files = result.files.slice(0, 200);
    result.totals = result.files.reduce((sum, file) => ({ files: sum.files + 1, added: sum.added + (file.added ?? 0), removed: sum.removed + (file.removed ?? 0) }), { files: 0, added: 0, removed: 0 });
    result.refusals = fleetEditRefusals(result.files.map(file => file.path)).map(({ path, rule }) => ({ path, rule }));
  } catch { result.state = 'degraded'; }
  return result;
}
