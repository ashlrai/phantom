/** Dispatcher tick duration, launch rate and timeout share. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readTickProfile } from '../core/fleet/tick-profile.js';

const USAGE = 'Usage: phm fleet tick-profile [--hours N] [--json]';
export async function cmdFleetTickProfile(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${USAGE}\nRead dispatchd.log over the last N hours (default 2). TICK summaries supply duration and phase timeouts; lowercase tick lines supply launches.\nPercentiles use nearest rank; timeout share is the fraction of summaries with expired phases. Launches/hour uses the full window. Missing samples show unknown. ASHLR_RUNS_DIR overrides the log folder.`);
    return 0;
  }
  let hours = 2;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (seen.has(flag) || !['--json', '--hours'].includes(flag)) { console.error(USAGE); return 2; }
    seen.add(flag);
    if (flag === '--hours') {
      const value = args[++i] ?? '';
      hours = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
      if (!Number.isFinite(hours) || hours <= 0) { console.error(`${USAGE}\n--hours needs a positive number`); return 2; }
    }
  }
  const report = await readTickProfile(join(process.env.ASHLR_RUNS_DIR || join(homedir(), '.ashlr-runs'), 'dispatchd.log'), hours);
  console.log(seen.has('--json') ? JSON.stringify(report) : !report.known ? 'Tick profile: unknown (cannot read dispatchd.log)' :
    `Ticks: ${report.tick_count}; wall seconds: p50 ${report.p50_seconds ?? 'unknown'}, p90 ${report.p90_seconds ?? 'unknown'}; launches/hour: ${report.launches_per_hour ?? 'unknown'}; timeout share: ${report.timeout_share === null ? 'unknown' : (100 * report.timeout_share).toFixed(1) + '%'}`);
  return report.known ? 0 : 1;
}
