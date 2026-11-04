import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseMainGuardianStatus, type FleetMainHealthRepo } from '../core/fleet/main-health.js';
import { readSource } from '../core/fleet/runs-parked-queue.js';

export interface FleetMainsOptions {
  read?: (path: string) => Promise<string>;
}

const USAGE = 'ashlr fleet mains [--json]\nRead main-guardian rows, red repos first. Exit 1: red or unavailable; 2: invalid arguments.';

async function readStatus(path: string): Promise<string> {
  const source = await readSource(path, 256 * 1024, false);
  if (source.state !== 'healthy') throw new Error('unavailable');
  return source.text;
}

/** Read-only, typed projection of the guardian table; no dispatch or network access. */
export async function cmdFleetMains(args: string[], opts: FleetMainsOptions = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(USAGE);
    return 0;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) {
    console.error(USAGE);
    return 2;
  }
  let repos: FleetMainHealthRepo[];
  try {
    const text = await (opts.read ?? readStatus)(join(homedir(), '.ashlr-runs', 'supervisor', 'status-main-guardian.md'));
    repos = parseMainGuardianStatus(text, Date.now()).repos;
    if (!repos.length) throw new Error('empty table');
  } catch {
    if (args[0] === '--json') console.log(JSON.stringify({ source: 'unavailable', repos: [] }));
    else console.error('fleet mains: guardian status unavailable');
    return 1;
  }
  repos.sort((a, b) => Number(b.state === 'red') - Number(a.state === 'red'));
  if (args[0] === '--json') console.log(JSON.stringify({ source: 'ok', repos }));
  else for (const row of repos) {
    console.log(`${row.repo}/${row.branch}: ${row.state}; SHA ${row.sha ?? 'unknown'}; checked ${row.checkedAt ?? 'unknown'}; failing check ${row.failingCheck ?? 'none'}; open fix jobs ${row.fixJobs.join(', ') || 'none'}; nightly CI red ${row.nightlyRed ?? 'none'}`);
  }
  return repos.some(row => row.state === 'red') ? 1 : 0;
}
