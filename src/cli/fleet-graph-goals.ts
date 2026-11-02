import { graphGoalsRun } from '../core/fleet/graph-goals-run.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: ashlr fleet graph-goals --file <absolute manifest> --targets <node-id,...> [--apply] [--timeout-ms <1..3600000>] [--concurrency <1..8>] --json';
const help = `${usage}\n` +
  'Runs exactly selected manifest nodes plus their transitive dependsOn prerequisites, or previews that\n' +
  'selection with zero effects when --apply is omitted. The entire original manifest is validated\n' +
  'before anything is selected, so an invalid unrelated branch or a manifest that changes under the\n' +
  'run launches nothing. --apply writes one private reduced manifest and delegates the single run to\n' +
  'the graph executor: control switches, cancellation and the shared --timeout-ms budget are not\n' +
  'bypassed. Skipped nodes are reported as skipped, never as successes.';

/** Convention-resolved CLI entry: `ashlr fleet graph-goals`. */
export async function cmdFleetGraphGoals(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(help);
    return 0;
  }
  let file = '', targets = '', apply = false, json = false, timeout = 900000, concurrency = 1;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) return 2;
    seen.add(arg);
    if (arg === '--apply') apply = true;
    else if (arg === '--json') json = true;
    else if (arg === '--file') file = args[++i] ?? '';
    else if (arg === '--targets') targets = args[++i] ?? '';
    else if (arg === '--concurrency' && /^[1-8]$/.test(args[i + 1] ?? '')) concurrency = Number(args[++i]);
    else if (arg === '--timeout-ms' && /^\d+$/.test(args[i + 1] ?? '')) timeout = Number(args[++i]);
    else return 2;
  }
  if (!json) return 2;
  const result = await graphGoalsRun(file, targets.split(','), apply, timeout, concurrency);
  console.log(JSON.stringify(sanitizePublicJson(result)));
  return ['invalid', 'invalid-target', 'unstable'].includes(result.status) ? 2
    : ['preview', 'complete'].includes(result.status) ? 0 : 1;
}
