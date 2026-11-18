/** Read-only list of jobs and lanes that count as launched or staffed but are not actually running, each with its reason and the one step that unblocks it. */
import { formatNotRunning, type NotRunningRow } from '../core/fleet/fleet-held.js';
import { defaultRunsDir } from '../core/fleet/landed-closes-read.js';
import { readFleetRunsDirState } from '../core/fleet/runs-dir-state.js';

const usage = 'Usage: phm fleet held [--json]';

export interface FleetHeldReport { schema: 'fleet.held.v1'; generatedAt: string; count: number; items: NotRunningRow[] }
/** Injected so tests never read the real runs directory. Default: ASHLR_RUNS_DIR, else the standard runs directory. */
export type FleetHeldReader = () => Promise<{ generatedAt: string; notRunning?: NotRunningRow[] }>;
const readHeld: FleetHeldReader = () => readFleetRunsDirState({ runsDir: defaultRunsDir() });

export async function cmdFleetHeld(args: string[], read: FleetHeldReader = readHeld): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nLists held launches, idle lanes, launches with no finish after 60 minutes and finishes with no publish record.\nExit 0 when the list was read, even when it is empty.`);
    return 0;
  }
  if (args.length > 1 || args.some(arg => arg !== '--json')) { console.error(usage); return 2; }
  let state: Awaited<ReturnType<FleetHeldReader>>;
  try { state = await read(); } catch { console.error('error: fleet state unavailable'); return 1; }
  const items = state.notRunning ?? [];
  const report: FleetHeldReport = { schema: 'fleet.held.v1', generatedAt: state.generatedAt, count: items.length, items };
  console.log(args[0] === '--json' ? JSON.stringify(report) : formatNotRunning(report.items));
  return 0;
}
