import { formatLaneAdaptText, readLaneAdapt, type LaneAdaptReport } from '../core/fleet/lane-adapt.js';

const USAGE = 'Usage: ashlr fleet lane-adapt [--since 6h] [--json]';
export async function cmdFleetLaneAdapt(
  args: string[],
  reader: (options: { sinceMs: number; now: () => number }) => Promise<LaneAdaptReport> = readLaneAdapt,
  now: () => number = Date.now,
): Promise<number> {
  let duration = 6 * 3_600_000;
  let json = false;
  let seenSince = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--since' && !seenSince) {
      seenSince = true;
      const match = /^(\d+)(m|h|d)$/.exec(args[++i] ?? '');
      if (!match) { console.error(USAGE); return 2; }
      duration = Number(match[1]) * (match[2] === 'm' ? 60_000 : match[2] === 'h' ? 3_600_000 : 86_400_000);
      if (!Number.isSafeInteger(duration) || duration <= 0 || duration > 365 * 86_400_000) { console.error(USAGE); return 2; }
    } else if (args.length === 1 && (args[i] === '--help' || args[i] === '-h')) { console.log(USAGE); return 0; }
    else { console.error(USAGE); return 2; }
  }
  const current = now();
  const report = await reader({ sinceMs: current - duration, now: () => current });
  console.log(json ? JSON.stringify(report) : formatLaneAdaptText(report));
  return 0;
}
