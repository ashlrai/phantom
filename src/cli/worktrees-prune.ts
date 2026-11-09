import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { readSource } from '../core/fleet/runs-parked-queue.js';
import { isKeptWorktree, measureWorktreeBytes, readKeptWorktrees } from '../core/worktree-retention.js';
import { parseJobLedger } from './disk.js';

export interface PruneDeps { root?: string; runsRoot?: string; now?: number }
export interface PruneEntry { name: string; path: string; reason: 'merged' | 'closed' | 'empty'; ageHours: number; sizeBytes: number; sizeComplete: boolean; status: 'eligible' | 'removed' | 'refused' }

/** Fail closed if lifecycle, pin, path or Git evidence cannot be verified. */
export async function pruneWorktrees(apply: boolean, deps: PruneDeps = {}): Promise<{ dryRun: boolean; worktrees: PruneEntry[]; errors: number }> {
  const root = resolve(deps.root ?? join(homedir(), 'Projects', 'ashlrai', 'wt'));
  const jobsPath = join(deps.runsRoot ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs'), 'metrics', 'jobs.jsonl');
  const now = deps.now ?? Date.now();
  const source = await readSource(jobsPath, 8 * 1024 * 1024, true);
  if (source.state !== 'healthy') return { dryRun: !apply, worktrees: [], errors: 1 };
  const ledger = parseJobLedger(source.text);
  const entries: PruneEntry[] = [];
  let errors = 0;
  const deadline = Date.now() + 20_000;
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory() || !/^RQ-[A-Za-z0-9._-]+$/.test(dir.name)) continue;
    const record = ledger.get(dir.name);
    const reason = record?.state === 'merged' ? 'merged' : record?.state === 'closed' ? 'closed'
      : record?.state === 'empty' || (record?.state === null && record.finishEmpty) ? 'empty' : null;
    if (!reason || record?.finishMs == null || now - record.finishMs <= 2 * 3_600_000) continue;
    const path = join(root, dir.name);
    const eligible = (): boolean => {
      try {
        if (!lstatSync(path).isDirectory() || dirname(realpathSync(path)) !== realpathSync(root) ||
          isKeptWorktree(path, readKeptWorktrees()) || process.cwd() === path || process.cwd().startsWith(path + sep)) return false;
        // Include ignored files: Git would otherwise discard them on removal.
        return execFileSync('git', ['-C', path, 'status', '--porcelain', '--untracked-files=all', '--ignored'], { timeout: 30_000, maxBuffer: 1024 * 1024 }).length === 0;
      } catch { return false; }
    };
    if (!eligible()) continue;
    const size = measureWorktreeBytes(path, { deadlineMs: deadline });
    const entry: PruneEntry = { name: dir.name, path, reason, ageHours: (now - record.finishMs) / 3_600_000, sizeBytes: size.bytes, sizeComplete: size.complete, status: 'eligible' };
    if (apply) {
      // Re-read the ledger and pin policy just before removal; a new attempt wins.
      const current = await readSource(jobsPath, 8 * 1024 * 1024, true);
      const latest = current.state === 'healthy' ? parseJobLedger(current.text).get(dir.name) : undefined;
      if (!latest || latest.state !== record.state || latest.finishMs !== record.finishMs || latest.finishEmpty !== record.finishEmpty || !eligible()) {
        entry.status = 'refused'; errors++;
      } else {
        try { execFileSync('git', ['-C', path, 'worktree', 'remove', '--', path], { timeout: 30_000, stdio: 'ignore' }); entry.status = 'removed'; }
        catch { entry.status = 'refused'; errors++; }
      }
    }
    entries.push(entry);
  }
  return { dryRun: !apply, worktrees: entries, errors };
}

export async function cmdWorktreesPrune(args: string[]): Promise<number> {
  const usage = 'Usage: phm worktrees prune [--dry-run | --apply] [--json]';
  if (args.includes('--help') || args.includes('-h')) { console.log(`${usage}\nLists clean, unkept job worktrees finished over two hours ago. Dry run is the default.`); return 0; }
  if (new Set(args).size !== args.length || args.some(a => !['--dry-run', '--apply', '--json'].includes(a)) || (args.includes('--dry-run') && args.includes('--apply'))) { console.error(usage); return 2; }
  try {
    const report = await pruneWorktrees(args.includes('--apply'));
    if (args.includes('--json')) console.log(JSON.stringify(report));
    else { for (const row of report.worktrees) console.log(`${row.name}: ${row.reason}, ${row.sizeBytes} bytes${row.sizeComplete ? '' : ' (partial)'}, ${row.status}`); console.log(`${report.worktrees.length} worktrees; ${report.errors} errors.`); }
    return report.errors ? 1 : 0;
  } catch { console.error('Cannot inspect worktrees.'); return 1; }
}
