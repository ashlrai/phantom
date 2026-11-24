/** One read-only EMPTY report, shared with fleet MCP, plus why each run ended empty. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fleetEmpties, readFleetEmpties, humanFleetEmpties } from '../core/fleet/empties.js';
import { emptiesWhyText, readEmptiesWhy, type EmptiesWhyReport } from '../core/fleet/empties-why.js';
import { sanitizePublicJson } from '../core/util/public-json.js';
export { fleetEmpties } from '../core/fleet/empties.js';

const usage = 'Usage: phm fleet empties [--hours 24 | --since 24h] [--jobs <jobs.jsonl>] [--runs-dir <directory>] [--human | --json]';
export async function cmdFleetEmpties(args: string[], read?: () => Promise<string | null>, now = Date.now()): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nJSON by default. Empty finishes, recorded causes, empty rate and top 5 job families. Reads metrics and explicit result-note paths only; unmatched evidence stays unknown.
"why" gives each empty run one reason (plan_limit, held, precheck_skip, publish_abort, already_done, blocked, no_output, unknown) with a short evidence line, tokens per reason, lane and family, and the 10 costliest empty runs.`); return 0;
  }
  let hours = 24, root = join(homedir(), '.ashlr-runs'), jobs: string | undefined, human = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg) || !['--since', '--hours', '--runs-dir', '--jobs', '--human', '--json'].includes(arg)) { console.error(usage); return 2; }
    seen.add(arg);
    if (arg === '--human' || arg === '--json') { human = arg === '--human'; continue; }
    const value = args[++i];
    if (!value || value.startsWith('-')) { console.error(usage); return 2; }
    if (arg === '--since') hours = /^\d+(?:\.\d+)?h$/.test(value) ? Number(value.slice(0, -1)) : NaN;
    else if (arg === '--hours') hours = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
    else if (arg === '--runs-dir') root = value;
    else jobs = value;
  }
  if (!Number.isFinite(hours) || hours <= 0 || hours > 2160 || (seen.has('--json') && seen.has('--human')) || (seen.has('--since') && seen.has('--hours'))) { console.error(usage); return 2; }
  const injected = read && !seen.has('--runs-dir') && !jobs;
  const [report, why] = await Promise.all([
    injected ? fleetEmpties(read, hours, now) : readFleetEmpties(hours, now, root, jobs),
    readEmptiesWhy({ hours, now, runsDir: root, jobsPath: jobs, ledger: injected ? read : undefined }),
  ]);
  const safeWhy = sanitizePublicJson(why) as EmptiesWhyReport;
  console.log(human ? [humanFleetEmpties(report), ...emptiesWhyText(safeWhy)].join('\n') : JSON.stringify({ ...report, why: safeWhy }));
  return report.known ? 0 : 1;
}
