import { collectTopPools, type TopPoolsSnapshot } from '../core/top-pools.js';

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

export async function cmdTop(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: phm top [--once] [--json]\nRead-only per-pool capacity and reset pressure; prints one snapshot.');
    return 0;
  }
  if (args.some(arg => !['--once', '--json'].includes(arg))) {
    console.error('Usage: phm top [--once] [--json]');
    return 2;
  }
  const snapshot = collectTopPools();
  console.log(args.includes('--json') ? JSON.stringify(snapshot) : renderTopPools(snapshot));
  return 0;
}
