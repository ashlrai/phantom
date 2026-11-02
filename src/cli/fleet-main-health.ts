/**
 * `ashlr fleet main-health [--json] [--strict]` — read-only view of the
 * main-guardian status table. Exit 0 by default; --strict exits 1 when any
 * repo is red, the status is stale, or it is unavailable, so agents can gate.
 */
import { readFleetMainHealth, type FleetMainHealthV1 } from '../core/fleet/main-health.js';

export interface FleetMainHealthOptions { runsDir?: string; now?: () => number }

function render(report: FleetMainHealthV1): string[] {
  const rows = [...report.repos].sort((a, b) => Number(b.state === 'red') - Number(a.state === 'red'));
  const lines = rows.map((row) => {
    const fix = row.fixJobs.length ? `, fix ${row.fixJobs.join(' ')}` : '';
    const failing = row.state === 'red' && row.failingCheck ? ` (${row.failingCheck})` : '';
    const nightly = row.nightlyRed ? `, nightly red ${row.nightlyRed}` : '';
    return `${row.repo}/${row.branch}: ${row.state}${failing}${fix}${nightly}`;
  });
  if (report.source === 'unavailable') lines.push('main-health: guardian status unavailable');
  else if (report.stale) lines.push(`main-health: guardian status stale (last ${report.statusAt ?? 'unknown'})`);
  if (report.guardianOff) lines.push('main-health: guardian is OFF (MAIN_GUARDIAN_OFF present)');
  return lines;
}

export async function cmdFleetMainHealth(args: string[], opts: FleetMainHealthOptions = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log('ashlr fleet main-health [--json] [--strict]\n' +
      'Read-only view of the main-guardian status: red default branches, failing check, open fix jobs.\n' +
      'Exit 0 by default; --strict exits 1 when any repo is red or the status is stale or unavailable.');
    return 0;
  }
  let json = false;
  let strict = false;
  for (const arg of args) {
    if (arg === '--json') json = true;
    else if (arg === '--strict') strict = true;
    else {
      console.error(`fleet main-health: unknown flag: ${arg}`);
      return 2;
    }
  }
  const report = await readFleetMainHealth(opts);
  if (json) console.log(JSON.stringify(report));
  else for (const line of render(report)) console.log(line);
  return strict && (report.red > 0 || report.stale || report.source === 'unavailable') ? 1 : 0;
}
