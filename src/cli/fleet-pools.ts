/**
 * `ashlr fleet pools` — per usage pool: will it run dry before reset
 * (starving), leave usage unspent (wasting), or land on pace, and which pool
 * should take the next job. Reads the dispatchd status ledger
 * (`budget.<lane>.use_it_all`), the same readings as the usage-resources API
 * and the desktop Resources list. Missing readings stay unknown. Advisory and
 * read-only: it never changes a target or dispatches.
 */
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { readUsagePace } from '../core/usage/pace.js';
import { poolSpendLine, type PoolShareSnapshot } from '../core/usage/runway.js';

const USAGE = 'Usage: ashlr fleet pools [--json] [--runs-dir <abs>]';

export interface FleetPoolsDeps {
  read?: (statusPath: string) => Promise<{ shares: PoolShareSnapshot }>;
  runsDir?: string;
}

export async function cmdFleetPools(args: string[], deps: FleetPoolsDeps = {}): Promise<number> {
  if (args.some(arg => arg === '--help' || arg === '-h')) { console.log(USAGE); return 0; }
  let runsDir = deps.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--runs-dir' && args[i + 1] !== undefined && isAbsolute(args[i + 1]!)) runsDir = args[++i]!;
    else { console.error(USAGE); return 2; }
  }
  const { shares } = await (deps.read ?? readUsagePace)(join(runsDir, 'queue', 'status.json'));
  if (json) { console.log(JSON.stringify(shares)); return 0; }
  console.log(shares.next_pool === null ? 'Next job: unknown (no pool is known to have room)' : `Next job: ${shares.next_pool}`);
  for (const row of shares.pools) console.log(poolSpendLine(row));
  return 0;
}
