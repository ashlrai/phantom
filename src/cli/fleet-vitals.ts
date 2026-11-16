import { homedir } from 'node:os';
import { join } from 'node:path';
import { readLaunchCosts } from '../core/fleet/launch-cost.js';

const usage = 'Usage: phm fleet vitals [--runs-dir <directory>] [--json]';
export async function cmdFleetVitals(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(`${usage}\nRead recorded launch process counts and sampled CPU during the first 60 seconds. Missing evidence is unknown.`); return 0; }
  let root = join(homedir(), '.ashlr-runs'), json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg) || !['--json', '--runs-dir'].includes(arg)) { console.error(usage); return 2; }
    seen.add(arg);
    if (arg === '--json') json = true;
    else if (args[i + 1] && !args[i + 1]!.startsWith('-')) root = args[++i]!;
    else { console.error(usage); return 2; }
  }
  const launchCost = await readLaunchCosts(root);
  console.log(json ? JSON.stringify({ schema: 'fleet.vitals.v1', launchCost }) :
    [`Launch cost: ${launchCost.state} (source ${launchCost.source})`, ...launchCost.launches.map(r =>
      `${r.launchId} / ${r.lane}: ${r.status}; peak processes ${r.peakProcesses ?? 'unknown'}; mean CPU ${r.meanCpuPercentOneCore ?? 'unknown'}%; peak CPU ${r.peakCpuPercentOneCore ?? 'unknown'}%; ${r.sampledSeconds}/60s sampled`)].join('\n'));
  return 0;
}
