import { loadConfigReadOnly } from '../core/config.js';
import { buildFleetDigest } from '../core/fleet/digest.js';
import { buildRollupAsync } from '../core/observability/rollup.js';
import { rankMetricsLevers } from '../core/observability/levers.js';

const USAGE = 'Usage: phm metrics levers [--window <7d|30d>] [--json]\nRanks three local rollup proxies; no model calls or writes.\n';

export async function cmdMetrics(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  let window: '7d' | '30d' = '7d';
  let json = false;
  let error = args[0] !== 'levers';
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--json') json = true;
    else if (args[i] === '--window') {
      const value = args[++i];
      if (value === '7d' || value === '30d') window = value;
      else error = true;
    } else error = true;
  }
  if (error) {
    process.stderr.write(USAGE);
    return 2;
  }
  try {
    const [activity, fleet] = await Promise.all([
      buildRollupAsync(window, loadConfigReadOnly()), buildFleetDigest(window),
    ]);
    const report = rankMetricsLevers(activity, fleet);
    process.stdout.write(json ? JSON.stringify(report) + '\n' : report.levers
      .map(l => `${l.rank}. ${l.id} (${l.score ?? 'unknown'}): ${l.reason}`).join('\n') + '\n');
    return 0;
  } catch {
    process.stderr.write('Unable to read local metrics.\n');
    return 1;
  }
}
