/** `phm local capacity [--json]`: how many local-model workers fit in free memory. Thin: parse argv, delegate to core. */
import { readLocalCapacity, type LocalCapacityDeps, type LocalCapacityReport } from '../core/fleet/local-capacity.js';

export const LOCAL_USAGE = `Usage: phm local capacity [--json]
How many local-model workers fit right now: free memory minus a 30% safety margin, divided by the memory one worker uses
(the median of recent local worker samples, else local.worker_gb, default 6 GB), held to the local lane ceiling.
Autofill and the lane planner use the same number. Read-only. --json prints schema local.capacity.v1.
Exit 0 report (even when the room is unknown), 2 bad usage.`;

export async function cmdLocal(args: string[], deps: LocalCapacityDeps & { read?: () => Promise<LocalCapacityReport> } = {}): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(LOCAL_USAGE); return 0; }
  const [verb, ...flags] = args;
  if (verb !== 'capacity' || flags.some(f => f !== '--json') || flags.length > 1) { console.error(LOCAL_USAGE); return 2; }
  const report = await (deps.read ?? (() => readLocalCapacity(deps)))();
  console.log(flags.length ? JSON.stringify(report) : report.summary);
  return 0;
}
