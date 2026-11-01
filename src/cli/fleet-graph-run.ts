import { graphArgvRun } from '../core/fleet/graph-argv-run.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: ashlr fleet graph-run --file <absolute manifest> [--apply] [--fail-fast] [--concurrency <1..8>] [--timeout-ms <1..3600000>] [--json]';
const help = `${usage}\n` +
  'Runs an explicit argv task graph, or previews it with zero effects when --apply is omitted.\n' +
  '--timeout-ms is the whole apply budget, not a per-node timeout: one monotonic deadline is\n' +
  'shared by control reads and every child. After it expires no node launches, active children\n' +
  'are stopped with the usual TERM then KILL escalation and awaited, and nodes that never\n' +
  'started are reported as deadline-exhausted. --concurrency only bounds how many children may\n' +
  'be active at once; it never extends or resets the budget. --fail-fast stops new launches\n' +
  'after a child fails; running children finish and unstarted nodes are skipped or blocked.';

export async function cmdFleetGraphRun(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(help);
    return 0;
  }
  let file = '', apply = false, failFast = false, timeout = 900000, concurrency = 1;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) return 2;
    seen.add(arg);
    if (arg === '--apply') apply = true;
    else if (arg === '--fail-fast') failFast = true;
    else if (arg === '--json') continue;
    else if (arg === '--file') file = args[++i] ?? '';
    else if (arg === '--concurrency' && /^[1-8]$/.test(args[i + 1] ?? '')) concurrency = Number(args[++i]);
    else if (arg === '--timeout-ms' && /^\d+$/.test(args[i + 1] ?? '')) timeout = Number(args[++i]);
    else return 2;
  }
  const result = await graphArgvRun(file, apply, timeout, concurrency, { failFast });
  console.log(JSON.stringify(sanitizePublicJson(result)));
  return result.status === 'invalid' ? 2 : ['preview', 'complete'].includes(result.status) ? 0 : 1;
}
