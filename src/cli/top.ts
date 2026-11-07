import { collectTopPools, type TopPoolsSnapshot } from '../core/top-pools.js';
import { collectTopSnapshot } from '../core/fleet/top.js';

export function renderTopPools(snapshot: TopPoolsSnapshot): string {
  const lines = [`Pool capacity | ${snapshot.generatedAt}`, `Source: ${snapshot.source}`,
    'Pool | Engine | Admission | Headroom | Reset kind | Reset at | Pressure'];
  for (const row of snapshot.pools) {
    const view = row.scheduling;
    lines.push([row.poolId, row.engine, view?.admission ?? 'unknown',
      view?.headroomPercent == null ? 'unknown' : `${view.headroomPercent}%`,
      view?.reset.kind ?? 'unknown', view?.reset.at ?? 'unknown', view?.opportunity.kind ?? 'unknown'].join(' | '));
  }
  lines.push('Local subscription signal (engine-wide, account attribution unknown):');
  for (const [engine, usage] of Object.entries(snapshot.localSubscriptionUsage)) {
    lines.push(`  ${engine}: ${usage ? `${usage.usedPercent}% used (${usage.windowLabel})` : 'unknown'}`);
  }
  lines.push('Read-only estimates; this panel does not authorize dispatch.');
  return lines.join('\n');
}

const USAGE = 'Usage: phm top [--once] [--json] | phm top --v1 [--fleet <path>]';

export async function cmdTop(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'Usage: phm top [--once] [--json]\n' +
      '       phm top --v1 [--fleet <path>]\n' +
      'Read-only per-pool capacity and reset pressure; prints one snapshot.\n' +
      '--v1 emits the top.v1 fleet/usage/quota/pace JSON contract instead.',
    );
    return 0;
  }
  const v1 = args.includes('--v1');
  let fleetPath: string | undefined;
  let fleetMissing = false;
  let fleetSeen = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--fleet') continue;
    fleetSeen += 1;
    const value = args[i + 1];
    if (!value || value.startsWith('-')) fleetMissing = true;
    else fleetPath = value;
  }
  const known = v1 ? ['--v1', '--fleet'] : ['--once', '--json'];
  const valid = args.every((arg, i) => known.includes(arg) || (i > 0 && args[i - 1] === '--fleet'));
  const dup = new Set(args).size !== args.length;
  if (!valid || dup || fleetMissing || fleetSeen > 1 || (!v1 && fleetSeen > 0)) {
    console.error(USAGE);
    return 2;
  }
  if (v1) {
    try {
      const snapshot = collectTopSnapshot({ fleetPath });
      console.log(JSON.stringify(snapshot));
      return snapshot.sources.fleet === 'ready' ? 0 : 1;
    } catch {
      // Never print source payloads, exception text, file paths or provider errors.
      console.error('Top snapshot unavailable.');
      return 1;
    }
  }
  const snapshot = collectTopPools();
  console.log(args.includes('--json') ? JSON.stringify(snapshot) : renderTopPools(snapshot));
  return 0;
}
