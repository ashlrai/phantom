import { homedir } from 'node:os';
import { join } from 'node:path';
import { readOrderTrace } from '../core/fleet/order-trace.js';
import { applyOrderResults, leaderNetworkItemResolver, planOrderResults,
  type OrderItemResolver, type OrderResultWriter } from '../core/fleet/order-result-bridge.js';

const usage = 'Usage: ashlr fleet order-results [--apply] [--json] [--runs-dir DIR]';
export interface FleetOrderResultsDeps {
  runsDir?: string;
  busRoot?: string;
  resolveItem?: OrderItemResolver;
  write?: OrderResultWriter;
  output?: (text: string) => void;
  error?: (text: string) => void;
  now?: () => number;
}
export async function cmdFleetOrderResults(args: string[], deps: FleetOrderResultsDeps = {}): Promise<number> {
  const output = deps.output ?? console.log;
  const error = deps.error ?? console.error;
  let root = deps.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  let apply = false;
  let json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') { output(usage); return 0; }
    if (seen.has(arg)) { error(usage); return 2; }
    seen.add(arg);
    if (arg === '--apply') apply = true;
    else if (arg === '--json') json = true;
    else if (arg === '--runs-dir' && args[i + 1] && !args[i + 1]!.startsWith('--')) root = args[++i]!;
    else { error(usage); return 2; }
  }
  let trace;
  try {
    trace = await readOrderTrace({ runsDir: root, now: deps.now });
    if (Object.values(trace.sources).every(state => state === 'missing')) {
      error('fleet order-results: trace cannot be read'); return 1;
    }
  } catch { error('fleet order-results: trace cannot be read'); return 1; }
  const planned = planOrderResults(trace, deps.resolveItem ?? leaderNetworkItemResolver(root));
  const counts = apply ? await applyOrderResults(root, planned, { busRoot: deps.busRoot, write: deps.write, now: deps.now }) : undefined;
  if (json) output(JSON.stringify({ apply, planned, ...(counts ?? {}) }));
  else if (counts) output(`written ${counts.written}, skipped ${counts.skipped}, failed ${counts.failed}`);
  else {
    for (const result of planned) output(`${result.itemId}: verified artifact=${result.artifact} (job ${result.jobId})`);
    output(`dry run: ${planned.length} results; add --apply to write`);
  }
  return 0;
}
