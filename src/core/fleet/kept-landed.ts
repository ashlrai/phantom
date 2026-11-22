import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultFs } from './wt-audit.js';
import { measureWorktreeBytes } from '../worktree-retention.js';

export interface KeptLandedRow {
  job: string; ageHours: number | null; filesChanged: number | null; linesChanged: number | null;
  base: string | null; landed: 'yes' | 'partial' | 'no' | 'unknown'; bytes: number; sizeComplete: boolean;
}
export interface KeptLandedReport {
  schema: 'fleet.kept-landed.v1'; readOnly: true; worktrees: KeptLandedRow[]; skipped: number; summary: string;
}

/** Reuse the audit's direct-directory lister; never recurse to discover worktrees. */
export async function readKeptLanded(options: { wtRoot?: string; runsRoot?: string; olderThanHours?: number; now?: number; fs?: typeof defaultFs; git?: (dir: string, args: string[], input?: string) => string; measure?: typeof measureWorktreeBytes } = {}): Promise<KeptLandedReport> {
  const root = options.wtRoot ?? join(homedir(), 'Projects/ashlrai/wt');
  const runs = options.runsRoot ?? join(homedir(), '.ashlr-runs'), now = options.now ?? Date.now();
  const fs = options.fs ?? defaultFs;
  const names = await fs.dirs(root);
  if (!names) throw new Error('Worktree root unavailable');
  const candidates: { job: string; ageHours: number | null }[] = [];
  for (const job of names) {
    if (await fs.mtime(join(root, job, '.git')) === null) continue;
    const times = [await fs.mtime(join(root, job)), await fs.mtime(join(runs, `${job}.log`))];
    const newest = Math.max(...times.filter((value): value is number => value !== null));
    candidates.push({ job, ageHours: Number.isFinite(newest) ? Math.max(0, (now - newest) / 3_600_000) : null });
  }
  candidates.sort((a, b) => (a.ageHours ?? -1) - (b.ageHours ?? -1) || a.job.localeCompare(b.job));
  const selected = candidates.filter(row => row.ageHours === null || row.ageHours >= (options.olderThanHours ?? 0)).slice(0, 600);
  const worktrees: KeptLandedRow[] = [];
  for (const candidate of selected) {
    const dir = join(root, candidate.job), deadline = Date.now() + 20_000;
    const git = (args: string[], input?: string): string => {
      if (Date.now() >= deadline) throw new Error('Deadline');
      if (options.git) return options.git(dir, args, input);
      return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', ...args], {
        cwd: dir, encoding: 'utf8', input, timeout: Math.max(1, deadline - Date.now()), killSignal: 'SIGKILL',
        maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' },
      });
    };
    const row: KeptLandedRow = { ...candidate, base: null, filesChanged: null, linesChanged: null, landed: 'unknown', bytes: 0, sizeComplete: false };
    try {
      const master = git(['rev-parse', '--verify', 'origin/master^{commit}']).trim();
      if (!/^[a-f0-9]{40,64}$/.test(master)) throw new Error('Invalid master');
      const marker = await fs.text(join(runs, `${row.job}.base`));
      if (marker === null && await fs.mtime(join(runs, `${row.job}.base`)) !== null) throw new Error('Base unavailable');
      const recorded = marker?.trim().split(/\s+/)[0];
      if (marker !== null && !/^[a-f0-9]{40,64}$/.test(recorded ?? '')) throw new Error('Invalid base');
      row.base = recorded ?? git(['merge-base', 'HEAD', master]).trim();
      if (!/^[a-f0-9]{40,64}$/.test(row.base)) throw new Error('Invalid base');
      const diff = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=none'];
      const files = git([...diff, '--name-only', '-z', row.base, '--']).split('\0').filter(Boolean);
      row.filesChanged = files.length;
      const stats = git([...diff, '--numstat', '-z', row.base, '--']).split('\0').filter(Boolean).map(line => line.split('\t').slice(0, 2));
      row.linesChanged = stats.some(parts => parts.includes('-')) ? null : stats.reduce((sum, parts) => sum + Number(parts[0]) + Number(parts[1]), 0);
      const different = new Set(git([...diff, '--name-only', '-z', master, '--']).split('\0'));
      const matched = files.filter(file => !different.has(file)).length;
      row.landed = matched === files.length ? 'yes' : matched > 0 ? 'partial' : 'no';
      if (row.landed !== 'yes') {
        const patch = git([...diff, '--binary', '--full-index', row.base, '--']);
        const id = git(['patch-id', '--stable'], patch).trim().split(' ')[0];
        const history = git(['log', '--no-ext-diff', '--no-textconv', '--diff-merges=first-parent', '-p', '--binary', '--full-index', `${row.base}..${master}`]);
        if (id && git(['patch-id', '--stable'], history).split('\n').some(line => line.split(' ')[0] === id)) row.landed = 'yes';
      }
    } catch { row.landed = 'unknown'; }
    const size = (options.measure ?? measureWorktreeBytes)(dir, { deadlineMs: deadline });
    row.bytes = size.bytes; row.sizeComplete = size.complete;
    worktrees.push(row);
  }
  const count = (state: KeptLandedRow['landed']) => worktrees.filter(row => row.landed === state).length;
  const skipped = candidates.length - selected.length;
  const size = `${(worktrees.reduce((sum, row) => sum + row.bytes, 0) / 1e9).toFixed(1)} GB${worktrees.every(row => row.sizeComplete) ? '' : ' (partial size)'}`;
  return { schema: 'fleet.kept-landed.v1', readOnly: true, worktrees, skipped,
    summary: `${worktrees.length} kept worktrees, ${size}: ${count('yes')} already landed, ${count('partial')} partly, ${count('no')} not landed, ${count('unknown')} unknown; ${skipped} skipped` };
}
