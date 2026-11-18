/** One read-only EMPTY report, shared with fleet MCP. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fleetEmpties, readFleetEmpties, humanFleetEmpties } from '../core/fleet/empties.js';
export { fleetEmpties } from '../core/fleet/empties.js';

const usage = 'Usage: phm fleet empties [--since 24h] [--jobs <jobs.jsonl>] [--runs-dir <directory>] [--human | --json]';
export async function cmdFleetEmpties(args: string[], read?: () => Promise<string | null>, now = Date.now()): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nJSON by default. Empty finishes, recorded causes, empty rate and top 5 job families. Reads metrics and explicit result-note paths only; unmatched evidence stays unknown.`); return 0;
  }
  let hours = 24, root = join(homedir(), '.ashlr-runs'), jobs: string | undefined, human = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg) || !['--since', '--runs-dir', '--jobs', '--human', '--json'].includes(arg)) { console.error(usage); return 2; }
    seen.add(arg);
    if (arg === '--human' || arg === '--json') { human = arg === '--human'; continue; }
    const value = args[++i];
    if (!value || value.startsWith('-')) { console.error(usage); return 2; }
    if (arg === '--since') hours = /^\d+(?:\.\d+)?h$/.test(value) ? Number(value.slice(0, -1)) : NaN;
    else if (arg === '--runs-dir') root = value;
    else jobs = value;
  }
  if (!Number.isFinite(hours) || hours <= 0 || hours > 2160 || (seen.has('--json') && seen.has('--human'))) { console.error(usage); return 2; }
  const report = read && !seen.has('--runs-dir') && !jobs ? await fleetEmpties(read, hours, now) : await readFleetEmpties(hours, now, root, jobs);
  console.log(human ? humanFleetEmpties(report) : JSON.stringify(report));
  return report.known ? 0 : 1;
}
