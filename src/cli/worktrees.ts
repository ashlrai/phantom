import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { rejectUnknownOptions } from './args.js';
import { formatWorktreeReapStatus, readWorktreeReapStatus } from '../core/fleet/worktree-reap-tick.js';
import { defaultRunsRoot, defaultWtRoot, formatWorktrees, readWorktrees, worktreeRemoveCommands, type WorktreesDeps, type WorktreesPlan, type WorktreesReport } from '../core/fleet/worktrees.js';

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

const REPORT_USAGE = 'Usage: phm worktrees report [--dir <worktrees-dir>] [--json]';
const USAGE = `Usage: phm worktrees [--json] [--reap [--dry-run | --apply | --plan | --status]]
       phm worktrees report [--dir <worktrees-dir>] [--json]
       phm worktrees prune [--dry-run | --apply] [--json]

List every job worktree with its job, repo, state (live job, merged, closed PR,
empty result, open PR, kept on purpose, unknown), age, size and whether it is
safe to remove. Safe means: the job finished and its PR merged or closed, its
result was empty, or its branch is already in origin/master; over 6 hours old,
no uncommitted changes, no live job and not kept on purpose.
`phm fleet reap` shows the same plan with a count for each reason.
  --reap            Preview removal of the safe worktrees (a dry run).
  --reap --plan     Print only the git worktree remove commands, one per line, for a script to run.
  --reap --apply    Remove them with git worktree remove (never --force).
  --reap --status   Show the scheduled reap: on or off, last run, removed, skipped, freed.
The fleet self-tick runs this reap on its own when there are more than 40
worktrees: up to 40 removals, once per 30 minutes. Create queue/worktree-reap.off
in the runs directory to turn it off.`;

type Output = { log: (text: string) => void; error: (text: string) => void };

export async function cmdWorktrees(args: string[], deps: WorktreesDeps & { output?: Output } = {}): Promise<number> {
  const out = deps.output ?? { log: console.log, error: console.error };
  if (args.includes('--help') || args.includes('-h')) {
    out.log(args[0] === 'report' ? REPORT_USAGE : USAGE);
    return 0;
  }
  if (args[0] === 'report') return cmdWorktreesReport(args.slice(1), out);
  const modes = ['--dry-run', '--apply', '--plan', '--status'];
  const allowed = ['--json', '--reap', ...modes];
  const bad = args.find(arg => !allowed.includes(arg));
  if (bad !== undefined || new Set(args).size !== args.length || modes.filter(flag => args.includes(flag)).length > 1
    || (modes.some(flag => args.includes(flag)) && !args.includes('--reap'))) {
    out.error(bad !== undefined ? `Unknown argument: ${bad}\n${USAGE}` : USAGE);
    return 2;
  }
  if (args.includes('--status')) {
    try {
      const status = await readWorktreeReapStatus(deps.runsRoot ?? defaultRunsRoot());
      if (args.includes('--json')) out.log(JSON.stringify(status));
      else for (const line of formatWorktreeReapStatus(status)) out.log(line);
      return 0;
    } catch { out.error('Cannot read the reap status.'); return 1; }
  }
  const plan = args.includes('--plan');
  const mode = !args.includes('--reap') ? 'list' : args.includes('--apply') ? 'apply' : 'dry-run';
  let report: WorktreesReport;
  try { report = await readWorktrees(mode, deps); }
  catch { out.error('Cannot read worktrees.'); return 1; }
  if (plan) {
    const commands = worktreeRemoveCommands(report, deps.wtRoot ?? defaultWtRoot());
    if (args.includes('--json')) out.log(JSON.stringify({ schema: 'worktrees.plan.v1', commands } satisfies WorktreesPlan));
    else for (const command of commands) out.log(command);
    return 0;
  }
  if (args.includes('--json')) out.log(JSON.stringify(report));
  else for (const line of formatWorktrees(report)) out.log(line);
  return (report.removals ?? []).every(removal => removal.status === 'removed') ? 0 : 1;
}

function cmdWorktreesReport(options: string[], out: Output): number {
  const error = rejectUnknownOptions(options, { flags: ['--json'], values: ['--dir'] });
  const dirIndex = options.indexOf('--dir');
  if (error || (dirIndex >= 0 && options[dirIndex + 1]?.startsWith('-')) || options.some((arg, index) => !arg.startsWith('-') && (dirIndex < 0 || index !== dirIndex + 1))) {
    out.error(error?.message ?? 'unexpected argument');
    return 1;
  }
  const root = resolve(dirIndex >= 0 ? options[dirIndex + 1]! : join(homedir(), 'Projects', 'ashlrai', 'wt'));
  try {
    const rows = reportWorktrees(root);
    if (options.includes('--json')) out.log(JSON.stringify(rows, null, 2));
    else {
      out.log('WORKTREE\tAGE (hours)\tSIZE (bytes)\tLAST LOG MTIME\tJOB STATE');
      for (const row of rows) out.log(`${row.name}\t${(row.ageMs / 3_600_000).toFixed(1)}\t${row.sizeBytes}\t${row.lastLogMtime ?? '-'}\t${row.jobState ?? '-'}`);
    }
    return 0;
  } catch (error) {
    out.error(`Cannot report worktrees: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
