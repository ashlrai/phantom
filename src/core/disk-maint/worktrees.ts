import { execFile } from 'node:child_process';
import { lstatSync, opendirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { ledgerPhase, ledgerPrUrl } from '../fleet/empty-cause.js';
import { ledgerEventTs, ledgerJobId, ledgerLifecycleEvent, ledgerOutcomeState } from '../fleet/jobs-ledger-dialect.js';
import { readSource, type Source } from '../fleet/runs-parked-queue.js';
import { parseKeepList, parsePsJobs } from '../fleet/wt-audit.js';
import { parseLedgerTs } from '../metrics/loop.js';
import { withDaemonGitHardening } from '../sandbox/safe-git.js';
import { protectedReason, type MaintRoots } from './protect.js';
import { isCommitId, isPullUrl, readWorktreeBridgeCommits, readWorktreePulls, type WorktreeEvidenceDeps } from './worktree-evidence.js';

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

type JobState = { reason: string; at: number; prHead?: string; failed?: boolean; hold?: boolean; prUrl?: string };
type ProcessText = { argv: string; cwd: string };
type Activity = { live: Set<string>; queued: Set<string>; kept: Set<string> };
export interface WorktreeDeps extends WorktreeEvidenceDeps {
  readWorktreeProcesses?: () => Promise<ProcessText | null>;
  worktreeHasUnpushed?: (path: string, prHead?: string) => Promise<boolean | null>;
}

function ledgerWorktreeOutcomes(jobs: { state: Source; text: string }, names: ReadonlySet<string>): Map<string, JobState> | null {
  if (jobs.state === 'degraded') return null;
  const result = new Map<string, JobState>();
  const groups = new Map<string, { rows: { row: Record<string, unknown>; at: number | null; order: number }[]; latest: number }>();
  for (const line of jobs.text.split('\n')) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; } catch { return null; }
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const job = ledgerJobId(row);
    if (job === null || !names.has(job) || !isWorktreeJobId(job)) continue;
    const phase = ledgerPhase(row);
    const at = ledgerEventTs(row, phase) ?? parseLedgerTs(row['ended_ts']);
    const group = groups.get(job) ?? { rows: [], latest: 0 };
    group.rows.push({ row, at, order: at ?? group.latest });
    group.latest = Math.max(group.latest, at ?? 0);
    groups.set(job, group);
  }
  for (const [job, { rows }] of groups) {
    let finish: JobState | undefined;
    let published: { url: string; head?: string } | undefined;
    let supervisorReview = false;
    let current: JobState = { reason: 'state-unknown', at: 0, hold: true };
    for (const { row, at } of rows.sort((a, b) => a.order - b.order)) {
      const phase = ledgerPhase(row);
      const event = ledgerLifecycleEvent(row, phase);
      const outcome = ledgerOutcomeState(row, event, phase);
      const url = ledgerPrUrl(row) ?? '';
      const isPr = isPullUrl(url);
      const head = isCommitId(row['headSha']) ? row['headSha'] : undefined;
      const unknown = { reason: 'state-unknown', at: at ?? 0, hold: true };
      if (event !== null && REOPEN.has(event)) {
        current = unknown;
        finish = undefined;
        published = undefined;
        supervisorReview = false;
      }
      if (event === 'finish') {
        const failed = row['empty'] === true || (Number.isInteger(row['exit_code']) && row['exit_code'] !== 0);
        finish = at === null ? undefined : failed
          ? { reason: 'terminal-failed', at, failed: true }
          : unknown;
        current = finish ?? unknown;
        published = undefined;
      }
      if (event === 'publish') {
        if (row['class'] === 'abort_secret_shape') supervisorReview = true;
        if (outcome === null || isPr) published = isPr ? { url, head: head ?? (published?.url === url ? published.head : undefined) } : undefined;
        if (outcome === null) current = published
          ? { reason: 'pr-state-unknown', at: at ?? 0, prUrl: published.url, hold: true }
          : finish ?? unknown;
      }
      if (outcome !== null) {
        const stamp = at ?? finish?.at;
        current = stamp !== undefined && stamp > 0 && TERMINAL.has(outcome)
          ? { reason: outcome.toLowerCase(), at: stamp, prHead: isPr ? head ?? (published?.url === url ? published.head : undefined) : undefined }
          : unknown;
      }
    }
    result.set(job, supervisorReview ? { reason: 'supervisor-review', at: current.at, hold: true } : current);
  }
  return result;
}

export async function worktreeOutcomes(jobs: { state: Source; text: string }, names: ReadonlySet<string>,
  roots: MaintRoots, deps: WorktreeEvidenceDeps): Promise<Map<string, JobState> | null> {
  const result = ledgerWorktreeOutcomes(jobs, names);
  if (!result) return null;
  const bridgeNames = [...names].filter(name => name.startsWith('RQ-') && isWorktreeJobId(name) && !result.has(name));
  const local = bridgeNames.length ? await (deps.readWorktreeBridgeCommits ?? readWorktreeBridgeCommits)(roots).catch(() => new Map()) : new Map();
  const urls = [...new Set([
    ...[...result.values()].flatMap(state => state.prUrl ?? []),
    ...bridgeNames.flatMap(name => { const url = local.get(name)?.prUrl; return url && isPullUrl(url) ? [url] : []; }),
  ])];
  const remote = await readWorktreePulls(roots, urls, bridgeNames.length > 0, deps.lookupWorktreePulls, deps.worktreePullCacheOnly);
  const pulls = new Map(remote.pulls.map(pull => [pull.url, pull]));
  for (const [job, state] of result) {
    if (!state.prUrl) continue;
    const pull = pulls.get(state.prUrl);
    if (pull?.state === 'OPEN') result.set(job, { reason: 'pr-open', at: pull.at, hold: true });
    else if (pull && state.at > 0) result.set(job, {
      reason: pull.state.toLowerCase(), at: Math.max(state.at, pull.at), prHead: pull.prHead,
    });
  }
  for (const name of bridgeNames) {
    const landed = local.get(name);
    const merged = remote.bridges && Object.hasOwn(remote.bridges, name) ? remote.bridges[name] : undefined;
    const linked = landed?.prUrl ? pulls.get(landed.prUrl) : undefined;
    const linkedHead = linked?.state === 'MERGED' && linked.mergeSha && linked.mergeSha === landed?.mergeSha ? linked.prHead : undefined;
    if (merged || landed) result.set(name, {
      prHead: linkedHead ?? merged?.prHead, at: Math.max(merged?.at ?? 0, landed?.at ?? 0), reason: 'bridge-merged',
    });
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
