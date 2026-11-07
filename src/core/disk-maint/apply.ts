/**
 * disk-maint apply - executes a plan, one re-validated candidate at a time.
 *
 * Every action re-runs the protect-list against the live path, re-checks the
 * entry's kind and freshness snapshot, then does the smallest possible thing:
 *
 *   delete-file     unlink - only when the file still has the planned size
 *                 and mtime (a touched file is kept, not eaten mid-write).
 *   compress-file   stream-gzip to <path>.gz with an exclusive create, hash-
 *                 verify the archive against the source, then unlink.
 *   rotate-compress rename a live rolling log to <name>.rotate-<epoch>, then
 *                 the same verified gzip; a failed gzip renames it back.
 *   delete-dir      rm -rf equivalent - only inside the managed roots, only
 *                 on a real directory whose realpath resolves there too.
 *   worktree-remove `git worktree remove` from the owning repo - never
 *                 --force, never a branch or ref mutation; dirty or missing
 *                 worktrees simply fail and stay.
 *
 * A failure moves on to the next candidate; freed bytes are counted per
 * class from what actually left the volume (compressed bytes stay behind).
 */
import { execFile } from 'node:child_process';
import {
  closeSync, constants, fsyncSync, lstatSync, openSync,
  realpathSync, renameSync, rmSync, unlinkSync,
  createReadStream, createWriteStream,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { promisify } from 'node:util';
import {
  artifactJobInactive, artifactJobName, candidateStillSafe, completedArtifactJobs, defaultFreeBytes,
  type DiskMaintPlan, type MaintCandidate, type MaintClassId,
} from './plan.js';
import { readSource, type Source } from '../fleet/runs-parked-queue.js';
import { protectedReason, protectedRoots, resolveMaintRoots, type MaintRoots } from './protect.js';

const execFileAsync = promisify(execFile);

export type ApplyStatus = 'done' | 'refused' | 'failed';
export interface ApplyItemResult {
  path: string;
  action: MaintCandidate['action'];
  status: ApplyStatus;
  /** Bytes actually reclaimed on the volume (0 for refused/failed). */
  freedBytes: number;
  detail?: string;
}
export interface ApplyClassResult {
  id: MaintClassId;
  results: ApplyItemResult[];
  freedBytes: number;
  failures: number;
  refusals: number;
}
export interface DiskMaintApplyResult {
  schema: 'disk-maint-apply.v1';
  generatedAt: string;
  freeGb: number | null;
  classes: ApplyClassResult[];
  totals: { freedBytes: number; failures: number; refusals: number; done: number };
}

export interface ApplyDeps {
  roots?: MaintRoots;
  /** Extra containment roots are never needed; managed roots are derived. */
  runner?: (file: string, args: string[]) => Promise<string>;
  now?: number;
  readJobs?: (path: string) => Promise<{ state: Source; text: string }>;
  freeBytes?: (path: string) => number | null | Promise<number | null>;
}

const defaultRunner = async (file: string, args: string[]): Promise<string> =>
  (await execFileAsync(file, args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })).stdout;

const real = (path: string): string | null => {
  try { return realpathSync.native(path); } catch { return null; }
};

/** Managed roots a directory removal must physically resolve inside. */
function managedRoots(roots: MaintRoots): string[] {
  const out: string[] = [];
  for (const path of [roots.ashlrDir, roots.runsDir, roots.wtDir, roots.sideProjectsDir, roots.hubDir]) {
    if (!path) continue;
    const physical = real(path);
    out.push(physical ?? resolve(path));
  }
  return out;
}

const inside = (root: string, path: string): boolean => {
  const rel = path.slice(root.length);
  return (path === root || (path.startsWith(root) && rel.startsWith(sep)));
};

function sha256(path: string, gunzip = false): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256');
    const source: NodeJS.ReadableStream = gunzip ? createReadStream(path).pipe(createGunzip()) : createReadStream(path);
    source.on('data', (chunk: Buffer) => hash.update(chunk));
    source.on('end', () => resolvePromise(hash.digest('hex')));
    source.on('error', rejectPromise);
  });
}

/**
 * Verified gzip-in-place: stream src through gzip into an exclusively
 * created dest, fsync, then prove the archive decompresses to the source's
 * exact bytes before the caller unlinks anything. Returns dest size.
 */
async function gzipVerified(src: string, dest: string): Promise<number> {
  const fd = openSync(dest, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await pipeline(createReadStream(src), createGzip(), createWriteStream(dest, { fd, autoClose: false }));
    fsyncSync(fd);
  } finally { closeSync(fd); }
  const [sourceHash, archivedHash] = await Promise.all([sha256(src), sha256(dest, true)]);
  if (sourceHash !== archivedHash) throw new Error('archive verification failed');
  return lstatSync(dest).size;
}

async function applyOne(candidate: MaintCandidate, roots: MaintRoots, protectedRootsList: readonly string[], runner: (f: string, a: string[]) => Promise<string>): Promise<ApplyItemResult> {
  const base = { path: candidate.path, action: candidate.action };
  const problem = candidateStillSafe(candidate, roots, protectedRootsList);
  if (problem === 'gone') return { ...base, status: 'refused', freedBytes: 0, detail: 'already gone' };
  if (problem) return { ...base, status: 'refused', freedBytes: 0, detail: problem };
  try {
    switch (candidate.action) {
      case 'delete-file':
        unlinkSync(candidate.path);
        return { ...base, status: 'done', freedBytes: candidate.bytes };
      case 'compress-file': {
        const gzBytes = await gzipVerified(candidate.path, `${candidate.path}.gz`);
        unlinkSync(candidate.path);
        return { ...base, status: 'done', freedBytes: Math.max(0, candidate.bytes - gzBytes), detail: `compressed to ${basename(candidate.path)}.gz` };
      }
      case 'rotate-compress': {
        const rotated = `${candidate.path}.rotate-${Date.now()}`;
        try { renameSync(candidate.path, rotated); }
        catch { return { ...base, status: 'failed', freedBytes: 0, detail: 'rename failed' }; }
        try {
          const gzBytes = await gzipVerified(rotated, `${rotated}.gz`);
          unlinkSync(rotated);
          return { ...base, status: 'done', freedBytes: Math.max(0, candidate.bytes - gzBytes), detail: `rotated to ${basename(rotated)}.gz` };
        } catch (error) {
          try { renameSync(rotated, candidate.path); } catch { /* leave rotated copy */ }
          return { ...base, status: 'failed', freedBytes: 0, detail: (error as Error).message };
        }
      }
      case 'delete-dir': {
        const physical = real(candidate.path);
        if (!physical || !managedRoots(roots).some(root => inside(root, physical!))) {
          return { ...base, status: 'refused', freedBytes: 0, detail: 'escaped managed roots' };
        }
        rmSync(candidate.path, { recursive: true });
        return { ...base, status: 'done', freedBytes: candidate.bytes };
      }
      case 'worktree-remove': {
        const physical = real(candidate.path);
        const wtRoots = [real(join(roots.runsDir, 'wt')) ?? join(roots.runsDir, 'wt'), real(roots.wtDir) ?? roots.wtDir];
        if (!physical || !wtRoots.some(root => inside(root, physical!))) {
          return { ...base, status: 'refused', freedBytes: 0, detail: 'escaped worktree roots' };
        }
        const common = (await runner('git', ['-C', physical, 'rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
        const repo = common.endsWith(`${sep}.git`) ? common.slice(0, -'.git'.length) : common;
        if (!repo || protectedReason(repo, roots, protectedRootsList)) {
          return { ...base, status: 'refused', freedBytes: 0, detail: 'repo unresolvable' };
        }
        await runner('git', ['-C', repo, 'worktree', 'remove', '--', candidate.path]);
        return { ...base, status: 'done', freedBytes: candidate.bytes };
      }
    }
  } catch (error) {
    return { ...base, status: 'failed', freedBytes: 0, detail: (error as Error).message.split('\n')[0] };
  }
}

export async function applyDiskMaint(plan: DiskMaintPlan, deps: ApplyDeps = {}): Promise<DiskMaintApplyResult> {
  const roots = deps.roots ?? plan.roots ?? resolveMaintRoots();
  const rootsList = protectedRoots(roots);
  const runner = deps.runner ?? defaultRunner;
  const classes: ApplyClassResult[] = [];
  for (const cls of plan.classes) {
    const results: ApplyItemResult[] = [];
    const item: ApplyClassResult = { id: cls.id, results, freedBytes: 0, failures: 0, refusals: 0 };
    if (!cls.enabled) { classes.push(item); continue; }
    for (const candidate of cls.candidates) {
      let eligible = true;
      if (cls.id === 'job-artifacts') {
        const job = artifactJobName(basename(candidate.path));
        try {
          const jobs = await (deps.readJobs ?? ((path: string) => readSource(path, 8 * 1024 * 1024, true)))(join(roots.runsDir, 'metrics', 'jobs.jsonl'));
          eligible = !!job && candidate.action === 'delete-file' && candidate.path === join(roots.runsDir, basename(candidate.path)) &&
            jobs.state === 'healthy' && completedArtifactJobs(jobs.text).has(job) && artifactJobInactive(roots, job);
        } catch { eligible = false; }
      }
      const result: ApplyItemResult = eligible ? await applyOne(candidate, roots, rootsList, runner) :
        { path: candidate.path, action: candidate.action, status: 'refused', freedBytes: 0, detail: 'job activity or completion unverified' };
      results.push(result);
      item.freedBytes += result.freedBytes;
      if (result.status === 'failed') item.failures++;
      else if (result.status === 'refused') item.refusals++;
    }
    classes.push(item);
  }
  let freeGb: number | null = null;
  try {
    const bytes = await (deps.freeBytes ?? defaultFreeBytes)(roots.runsDir);
    if (typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0) freeGb = Math.round(bytes / 1e8) / 10;
  } catch { /* free space unavailable */ }
  return {
    schema: 'disk-maint-apply.v1',
    generatedAt: new Date(deps.now ?? Date.now()).toISOString(),
    freeGb,
    classes,
    totals: {
      freedBytes: classes.reduce((s, c) => s + c.freedBytes, 0),
      failures: classes.reduce((s, c) => s + c.failures, 0),
      refusals: classes.reduce((s, c) => s + c.refusals, 0),
      done: classes.reduce((s, c) => s + c.results.filter(r => r.status === 'done').length, 0),
    },
  };
}
