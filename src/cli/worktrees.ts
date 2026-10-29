import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { rejectUnknownOptions } from './args.js';

export interface WorktreeReport {
  name: string;
  path: string;
  ageMs: number;
  sizeBytes: number;
  lastLogMtime: string | null;
  jobState: string | null;
}

/** Inspect regular files only. Symlinks are counted but never followed. */
export function reportWorktrees(root: string, now = Date.now()): WorktreeReport[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const path = join(root, entry.name);
      const stat = lstatSync(path);
      let sizeBytes = 0;
      let lastLog = 0;
      const walk = (dir: string): void => {
        for (const child of readdirSync(dir, { withFileTypes: true })) {
          const file = join(dir, child.name);
          const info = lstatSync(file);
          if (info.isDirectory()) walk(file);
          else {
            sizeBytes += info.size;
            if (info.isFile() && child.name.endsWith('.log')) lastLog = Math.max(lastLog, info.mtimeMs);
          }
        }
      };
      walk(path);
      let jobState: string | null = null;
      try {
        const statusPath = join(path, 'status.json');
        const status: unknown = lstatSync(statusPath).isFile() ? JSON.parse(readFileSync(statusPath, 'utf8')) : null;
        if (status && typeof status === 'object' && 'state' in status && typeof status.state === 'string') jobState = status.state;
      } catch { /* Missing or invalid status has no known state. */ }
      return { name: entry.name, path, ageMs: Math.max(0, now - stat.birthtimeMs), sizeBytes, lastLogMtime: lastLog ? new Date(lastLog).toISOString() : null, jobState };
    });
}

const USAGE = 'Usage: phm worktrees report [--dir <worktrees-dir>] [--json]';

export function cmdWorktrees(args: string[]): number {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  if (args[0] !== 'report') {
    console.error(USAGE);
    return 1;
  }
  const options = args.slice(1);
  const error = rejectUnknownOptions(options, { flags: ['--json'], values: ['--dir'] });
  const dirIndex = options.indexOf('--dir');
  if (error || (dirIndex >= 0 && options[dirIndex + 1]?.startsWith('-')) || options.some((arg, index) => !arg.startsWith('-') && (dirIndex < 0 || index !== dirIndex + 1))) {
    console.error(error?.message ?? 'unexpected argument');
    return 1;
  }
  const root = resolve(dirIndex >= 0 ? options[dirIndex + 1]! : join(homedir(), 'Projects', 'ashlrai', 'wt'));
  try {
    const rows = reportWorktrees(root);
    if (options.includes('--json')) console.log(JSON.stringify(rows, null, 2));
    else {
      console.log('WORKTREE\tAGE (hours)\tSIZE (bytes)\tLAST LOG MTIME\tJOB STATE');
      for (const row of rows) console.log(`${row.name}\t${(row.ageMs / 3_600_000).toFixed(1)}\t${row.sizeBytes}\t${row.lastLogMtime ?? '-'}\t${row.jobState ?? '-'}`);
    }
    return 0;
  } catch (error) {
    console.error(`Cannot report worktrees: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
