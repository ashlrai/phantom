/** `phm empties`: thin handler. Parses argv and prints the report built in core/fleet/empties.ts. */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { emptiesText, readEmpties } from '../core/fleet/empties.js';
import { defaultRunsDir } from '../core/fleet/landed-closes-read.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: phm empties [--since 24h] [--text] [--metrics <file>] [--runs-dir <directory>] [--notes-dir <directory>]
Why jobs finished with no change, grouped by reason: already on master, no eligible target found,
no diff, blocked tool, missing tool, precheck skip, timeout, model limit or error, and unknown. Each reason shows its count,
share of all finishes, tokens spent, the lanes and job families most affected, and one next step.
Families rank by empty rate, then wasted tokens; suppress only above 60% with at least five finishes.
Prints JSON (schema empties.v1); --text prints at most 20 plain lines. Read-only.
  --since <n>h|<n>d   window to report, default 24h
  --metrics <file>    job metrics file, default <runs-dir>/metrics/jobs.jsonl
  --runs-dir <dir>    fleet runs directory, default ASHLR_RUNS_DIR or ~/.ashlr-runs
  --notes-dir <dir>   job worktrees holding <job>/BRIDGE_NOTES.md, default ASHLR_WT_DIR or ~/Projects/ashlrai/wt
Anything not measured prints as null (JSON) or "unknown" (text), never as zero. Exit 1 when the metrics file is unreadable.`;

export interface EmptiesDeps { now?: () => number; out?: (line: string) => void; err?: (line: string) => void }

export async function cmdEmpties(args: string[], deps: EmptiesDeps = {}): Promise<number> {
  const out = deps.out ?? console.log;
  const err = deps.err ?? console.error;
  if (args.includes('--help') || args.includes('-h')) { out(usage); return 0; }
  let hours = 24, text = false;
  const paths: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--text') text = true;
    else if (arg === '--json') text = false;
    else if (arg === '--since') {
      const match = /^(\d+(?:\.\d+)?)([hd])$/.exec(args[++i] ?? '');
      hours = match ? Number(match[1]) * (match[2] === 'd' ? 24 : 1) : NaN;
      if (!(hours > 0 && hours <= 8760)) { err(`phm empties: --since takes a window such as 24h or 7d\n${usage}`); return 2; }
    } else if (['--metrics', '--runs-dir', '--notes-dir'].includes(arg) && args[i + 1] && !args[i + 1]!.startsWith('-')) {
      paths[arg] = resolve(args[++i]!);
    } else { err(`phm empties: unknown or incomplete option ${arg}\n${usage}`); return 2; }
  }
  const runsDir = paths['--runs-dir'] ?? defaultRunsDir();
  const report = await readEmpties({
    metricsPath: paths['--metrics'] ?? join(runsDir, 'metrics', 'jobs.jsonl'),
    runsDir,
    notesDir: paths['--notes-dir'] ?? (process.env.ASHLR_WT_DIR?.trim() || join(homedir(), 'Projects/ashlrai/wt')),
    hours,
    now: (deps.now ?? Date.now)(),
  });
  out(text ? emptiesText(report).map(line => sanitizePublicJson(line)).join('\n') : JSON.stringify(sanitizePublicJson(report)));
  return report.metrics === 'ok' ? 0 : 1;
}
