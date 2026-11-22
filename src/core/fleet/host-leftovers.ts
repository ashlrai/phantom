/** Cwd and live-claim evidence for the existing host-load snapshot. Never reads argv. */
import { execFile } from 'node:child_process';
import { lstatSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { scrubSecrets } from '../util/scrub.js';
import type { ProcessRow } from './host-load.js';

export interface LeftoverEvidence { worktreeRoot: string; cwds: ReadonlyMap<number, string>; liveJobs: ReadonlyMap<string, boolean | null> }
export interface LeftoverProcess { pid: number; job: string; tool: string; cpu: number; ageSeconds: number | null }
export const leftoverJob = (cwd: string, root: string): string | undefined =>
  /^([A-Za-z0-9][\w.-]{0,127})(?:\/|$)/.exec(relative(root, cwd))?.[1];

export function findHostLeftovers(rows: readonly ProcessRow[], evidence?: LeftoverEvidence, ages = new Map<number, number | null>()) {
  const items: LeftoverProcess[] = [];
  let known = evidence !== undefined;
  for (const row of rows.filter(r => r.ppid === 1)) {
    const cwd = evidence?.cwds.get(row.pid), job = cwd && evidence ? leftoverJob(cwd, evidence.worktreeRoot) : undefined;
    if (!cwd || job && evidence?.liveJobs.get(job) == null) known = false;
    if (job && evidence?.liveJobs.get(job) === false) items.push({ pid: row.pid, job: scrubSecrets(job),
      tool: scrubSecrets(basename(row.command.trim().split(/\s+/)[0]!)).replace(/[^\w.+-]/g, '').slice(0, 64) || 'unknown', cpu: row.cpu, ageSeconds: ages.get(row.pid) ?? null });
  }
  items.sort((a, b) => b.cpu - a.cpu || a.pid - b.pid);
  return { state: known ? 'known' as const : 'unknown' as const, items, processes: items.length,
    cpuPercent: Math.round(items.reduce((sum, row) => sum + row.cpu, 0) * 10) / 10, jobs: [...new Set(items.map(row => row.job))].slice(0, 5) };
}

export async function readLeftoverEvidence(rows: readonly ProcessRow[], runsDir = process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs')): Promise<LeftoverEvidence> {
  const cwds = new Map<number, string>(), worktreeRoot = join(homedir(), 'Projects/ashlrai/wt');
  const candidates = rows.filter(row => row.ppid === 1);
  if (process.platform === 'linux') for (const row of candidates) {
    try { cwds.set(row.pid, readlinkSync(`/proc/${row.pid}/cwd`)); } catch { /* unknown cwd */ }
  }
  else if (process.platform === 'darwin' && candidates.length) {
    const text = await new Promise<string>(resolve => execFile('/usr/sbin/lsof', ['-nP', '-a', '-p', candidates.map(r => r.pid).join(','), '-d', 'cwd', '-Fpn'],
      { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => resolve(!error || error.code === 1 ? stdout : '')));
    let pid = 0;
    for (const line of text.split('\n')) {
      if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
      else if (line.startsWith('n/')) cwds.set(pid, line.slice(1));
    }
  }
  const liveJobs = new Map<string, boolean | null>(), pids = new Set(rows.map(r => r.pid));
  let claimsKnown = false;
  try { const stat = lstatSync(join(runsDir, 'queue/run')); claimsKnown = stat.isDirectory() && !stat.isSymbolicLink(); } catch { /* unknown claims */ }
  for (const cwd of cwds.values()) {
    const job = leftoverJob(cwd, worktreeRoot);
    if (!job || liveJobs.has(job)) continue;
    if (!claimsKnown) { liveJobs.set(job, null); continue; }
    const file = join(runsDir, 'queue/run', `${job}.pid`);
    try {
      lstatSync(file);
      const result = readStableRegularFile(file, { anchorPath: runsDir, maxFileBytes: 128, remainingBytes: 128 });
      liveJobs.set(job, result.ok && /^\d+\s*$/.test(result.text) ? pids.has(Number(result.text.trim())) : null);
    } catch (error) { liveJobs.set(job, (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : null); }
  }
  return { worktreeRoot, cwds, liveJobs };
}
