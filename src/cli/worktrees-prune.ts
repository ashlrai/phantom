import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { readSource } from '../core/fleet/runs-parked-queue.js';
import { isKeptWorktree, measureWorktreeBytes, readKeptWorktrees } from '../core/worktree-retention.js';
import { parseJobLedger } from './disk.js';
import { readWtAudit } from '../core/fleet/wt-audit.js';

export interface PruneDeps { root?: string; runsRoot?: string; now?: number; ps?: () => string | null }
export interface PruneEntry { name: string; path: string; reason: 'merged' | 'closed' | 'empty'; ageHours: number; sizeBytes: number; sizeComplete: boolean; status: 'eligible' | 'removed' | 'refused' }

/** Fail closed if lifecycle, pin, path or Git evidence cannot be verified. */
export async function pruneWorktrees(apply: boolean, deps: PruneDeps = {}): Promise<{ dryRun: boolean; worktrees: PruneEntry[]; errors: number }> {
  const root = resolve(deps.root ?? join(homedir(), 'Projects', 'ashlrai', 'wt'));
  const jobsPath = join(deps.runsRoot ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs'), 'metrics', 'jobs.jsonl');
  const now = deps.now ?? Date.now();
  const source = await readSource(jobsPath, 8 * 1024 * 1024, true);
  if (source.state !== 'healthy') return { dryRun: !apply, worktrees: [], errors: 1 };
  const ledger = parseJobLedger(source.text);
  const audit = () => readWtAudit({ wtRoot: root, runsRoot: deps.runsRoot ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs'), now, wantSize: false, ps: deps.ps });
  const safe = (report: Awaited<ReturnType<typeof readWtAudit>>, name: string): boolean => {
    const sources = report.sources;
    if (sources.worktrees !== 'healthy' || sources.runs !== 'healthy' || sources.jobs !== 'healthy' || sources.ps !== 'healthy' || sources.pins !== 'valid' || [sources.queue, sources.keep, sources.run, sources.status].includes('degraded')) return false;
    const row = report.worktrees.find(item => item.name === name);
    return !!row && !row.blockers.some(blocker => !blocker.startsWith('not-terminal:') && blocker !== 'fresh');
  };
  const initialAudit = await audit();
  const entries: PruneEntry[] = [];
  const s = initialAudit.sources;
  let errors = s.worktrees !== 'healthy' || s.runs !== 'healthy' || s.jobs !== 'healthy' || s.ps !== 'healthy' || s.pins !== 'valid' || [s.queue, s.keep, s.run, s.status].includes('degraded') ? 1 : 0;
  const deadline = Date.now() + 20_000;
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory() || !/^RQ-[A-Za-z0-9._-]+$/.test(dir.name)) continue;
    const record = ledger.get(dir.name);
    const reason = record?.state === 'merged' ? 'merged' : record?.state === 'closed' ? 'closed'
      : record?.state === 'empty' || (record?.state === null && record.finishEmpty) ? 'empty' : null;
    if (!reason || record?.finishMs == null || record.finishMs > now || (reason === 'empty' && now - record.finishMs <= 6 * 3_600_000) || !safe(initialAudit, dir.name)) continue;
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
      if (!latest || latest.state !== record.state || latest.finishMs !== record.finishMs || latest.finishEmpty !== record.finishEmpty || !safe(await audit(), dir.name) || !eligible()) {
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
  if (args.includes('--help') || args.includes('-h')) { console.log(`${usage}\nPreview clean, inactive worktrees for merged or closed jobs and empty jobs finished over six hours ago. Dry run is the default.`); return 0; }
  if (new Set(args).size !== args.length || args.some(a => !['--dry-run', '--apply', '--json'].includes(a)) || (args.includes('--dry-run') && args.includes('--apply'))) { console.error(usage); return 2; }
  try {
    const report = await pruneWorktrees(args.includes('--apply'));
    if (args.includes('--json')) console.log(JSON.stringify(report));
    else { for (const row of report.worktrees) console.log(`${row.name}: ${row.reason}, ${row.sizeBytes} bytes${row.sizeComplete ? '' : ' (partial)'}, ${row.status}`); console.log(`${report.worktrees.length} worktrees ${report.dryRun ? 'can be removed' : 'checked'}; ${report.errors} errors.${report.dryRun ? ' Run phm worktrees prune --apply to remove them.' : ''}`); }
    return report.errors ? 1 : 0;
  } catch { console.error('Cannot inspect worktrees.'); return 1; }
}
