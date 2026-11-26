import { execFile } from 'node:child_process';
import { lstatSync, opendirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { ledgerPhase, ledgerPrUrl } from '../fleet/empty-cause.js';
import { ledgerEventTs, ledgerJobId, ledgerLifecycleEvent, ledgerOutcomeState } from '../fleet/jobs-ledger-dialect.js';
import { readSource, type Source } from '../fleet/runs-parked-queue.js';
import { parseKeepList, parsePsJobs } from '../fleet/wt-audit.js';
import { withDaemonGitHardening } from '../sandbox/safe-git.js';
import { protectedReason, type MaintRoots } from './protect.js';

const run = promisify(execFile);
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REOPEN = new Set(['launch', 'enqueue', 'enqueued', 'queued', 'claim', 'batch_claim']);
const TERMINAL = new Set(['MERGED', 'CLOSED', 'DONE-NOOP']);
export const isWorktreeJobId = (name: string): boolean => JOB_ID.test(name) && !name.includes('..');
const gitOptions = () => ({
  env: {
    ...withDaemonGitHardening(Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))),
    GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1',
  },
  timeout: 2_000,
});

type JobState = { reason: string; at: number; prHead?: string };
type ProcessText = { argv: string; cwd: string };
type Activity = { live: Set<string>; queued: Set<string>; kept: Set<string> };
export interface WorktreeDeps {
  readWorktreeProcesses?: () => Promise<ProcessText | null>;
  worktreeHasUnpushed?: (path: string, prHead?: string) => Promise<boolean | null>;
}

export function worktreeOutcomes(jobs: { state: Source; text: string }): Map<string, JobState> | null {
  if (jobs.state !== 'healthy') return null;
  const result = new Map<string, JobState>();
  const finishes = new Map<string, number>();
  const published = new Map<string, { url: string; head: string }>();
  for (const line of jobs.text.split('\n')) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; } catch { return null; }
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const job = ledgerJobId(row);
    if (job === null || !JOB_ID.test(job)) continue;
    const phase = ledgerPhase(row);
    const event = ledgerLifecycleEvent(row, phase);
    const outcome = ledgerOutcomeState(row, event, phase);
    const at = ledgerEventTs(row, phase);
    const url = ledgerPrUrl(row) ?? '';
    const isPr = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(url);
    const head = typeof row['headSha'] === 'string' && /^[0-9a-f]{40}$/.test(row['headSha']) ? row['headSha'] : undefined;
    if (event !== null && (REOPEN.has(event) || event === 'publish')) {
      result.delete(job);
      finishes.delete(job);
      published.delete(job);
    }
    if (event === 'publish' && isPr && head) published.set(job, { url, head });
    if (event === 'finish') {
      if (at !== null) finishes.set(job, at);
      if (result.get(job)?.reason === 'empty') result.delete(job);
      if (at !== null && row['empty'] === true && !result.has(job)) result.set(job, { reason: 'empty', at });
    }
    if (outcome !== null) {
      result.delete(job);
      const stamp = at ?? finishes.get(job);
      const prior = published.get(job);
      if (stamp !== undefined && TERMINAL.has(outcome)) {
        result.set(job, { reason: outcome.toLowerCase(), at: stamp, prHead: isPr ? head ?? (prior?.url === url ? prior.head : undefined) : undefined });
      }
    } else if (event === 'publish' && at !== null && job.startsWith('RQ-DEVINCLOUD-') && isPr) {
      result.set(job, { reason: 'publisher-pushed', at, prHead: head });
    }
  }
  return result;
}

async function readProcesses(): Promise<ProcessText | null> {
  const options = { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 };
  try {
    const [ps, cwd] = await Promise.all([
      run('/bin/ps', ['-axww', '-o', 'command='], options),
      run('lsof', ['-nP', '-w', '-d', 'cwd', '-Fn'], { ...options, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } }),
    ]);
    return ps.stdout.trim() && cwd.stdout.trim() ? { argv: ps.stdout, cwd: cwd.stdout } : null;
  } catch { return null; }
}

export async function worktreeActivity(roots: MaintRoots, deps: WorktreeDeps): Promise<Activity | null> {
  const queue = join(roots.runsDir, 'queue');
  const [ready, keep, ps] = await Promise.all([
    readSource(join(queue, 'ready.tsv'), 8 * 1024 * 1024, false),
    readSource(join(queue, 'keep.txt'), 256 * 1024, false),
    (deps.readWorktreeProcesses ?? readProcesses)().catch(() => null),
  ]);
  if (!ps || ready.state === 'degraded' || keep.state === 'degraded') return null;
  const queued = new Set<string>();
  for (const line of ready.text.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    for (const cell of line.split('\t')) {
      const token = cell.trim();
      if (JOB_ID.test(token)) queued.add(token);
    }
  }
  const live = new Set<string>();
  for (const wtRoot of [roots.wtDir, join(roots.runsDir, 'wt')]) {
    const argv = parsePsJobs(ps.argv, { wtRoot, runsRoot: roots.runsDir });
    for (const job of [...argv.alive, ...argv.publishing, ...argv.reaping]) live.add(job);
    for (const line of ps.cwd.split('\n')) {
      if (!line.startsWith(`n${wtRoot}/`)) continue;
      const job = line.slice(wtRoot.length + 2).split('/')[0]!;
      if (JOB_ID.test(job)) live.add(job);
    }
  }
  return { live, queued, kept: parseKeepList(keep.text) };
}

export function worktreeHold(roots: MaintRoots, name: string, activity: Activity | null): string | null {
  if (!JOB_ID.test(name) || name.startsWith('guardian-')) return 'excluded';
  if (activity === null) return 'activity-unknown';
  if (activity.live.has(name)) return 'live-process';
  if (activity.queued.has(name)) return 'queued';
  if (activity.kept.has(name)) return 'kept';
  for (const suffix of ['.batched', '.dispatched', '.reaping', '.pid', '.bundle-wt']) {
    try { lstatSync(join(roots.runsDir, 'queue', 'run', name + suffix)); return 'active-lease'; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'activity-unknown'; }
  }
  return null;
}

export async function worktreePayloadHold(path: string, roots: MaintRoots, protectedRoots: readonly string[], deadline: number): Promise<string | null> {
  try {
    const physical = realpathSync.native(path);
    const root = lstatSync(path);
    if (!root.isDirectory() || root.isSymbolicLink() || protectedReason(physical, roots, protectedRoots)) return 'protected-path';
    let seen = 0;
    let tracked: Set<string> | undefined;
    const pending = [physical];
    while (pending.length) {
      if (Date.now() >= deadline) return 'payload-unknown';
      const dir = pending.pop()!;
      const before = lstatSync(dir);
      if (!before.isDirectory() || before.dev !== root.dev || realpathSync.native(dir) !== dir) return 'payload-unknown';
      const entries = opendirSync(dir);
      try {
        for (;;) {
          if (Date.now() >= deadline) return 'payload-unknown';
          const entry = entries.readSync();
          if (!entry) break;
          if (++seen > 100_000) return 'payload-unknown';
          if (dir === physical && entry.name === '.git' && entry.isFile()) continue;
          const child = join(dir, entry.name);
          if (/\.keep$/i.test(entry.name) || /^\.git$/i.test(entry.name)) return 'protected-payload';
          if (protectedReason(child, roots, protectedRoots)) {
            tracked ??= await run('git', ['-C', physical, 'ls-tree', '-rt', '--name-only', '-z', 'HEAD'], {
              ...gitOptions(), timeout: Math.max(1, deadline - Date.now()), maxBuffer: 4 * 1024 * 1024,
            }).then(({ stdout }) => new Set(stdout.split('\0')), () => new Set<string>());
            if (!tracked.has(relative(physical, child))) return 'protected-payload';
          }
          if (entry.isDirectory()) pending.push(child);
        }
      } finally { entries.closeSync(); }
      const after = lstatSync(dir);
      if (after.dev !== before.dev || after.ino !== before.ino) return 'payload-unknown';
    }
    return null;
  } catch { return 'payload-unknown'; }
}

export async function worktreeHasUnpushed(path: string, prHead?: string): Promise<boolean | null> {
  try {
    const physical = realpathSync.native(path);
    if (physical !== path && dirname(physical) !== realpathSync.native(dirname(path))) return null;
    if (basename(physical) !== basename(path) || lstatSync(path).isSymbolicLink() || !lstatSync(join(path, '.git')).isFile()) return null;
    const options = { ...gitOptions(), maxBuffer: 4096 };
    if (prHead) {
      const current = await run('git', ['-C', physical, 'rev-parse', '--verify', 'HEAD^{commit}'], options);
      if (current.stdout.trim() === prHead) return false;
    }
    const { stdout } = await run('git', ['-C', physical, 'rev-list', '--max-count=1', 'HEAD', '--not', '--remotes'], options);
    return stdout.trim() !== '';
  } catch { return null; }
}
