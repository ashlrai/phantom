import { sanitizePublicJson } from '../core/util/public-json.js';
import { scrubSecrets } from '../core/util/scrub.js';
import {
  POOL_NAME_PATTERN,
  showPoolReadings,
  type PoolReadingView,
} from '../core/usage/pool-reading.js';

const usage = 'Usage: phm fleet pool-readings [<pool>] [--json]';
const HELP = `${usage}
Reports the last measured usage sample recorded per pool: used percent, record
age, provider reset time and source label. READ-ONLY: recorded metadata is
opened without following links, never refreshed, re-measured or mutated, and an
old or expired record stays an explicitly stale measurement. Absent or invalid
records report unknown; a measured zero is a measured zero. Nothing here
changes lanes, holds or reserves, and nothing infers remaining entitlement.
Exit 0 when the records were read; 1 when they are unreadable; 2 on bad usage.`;

/** The reading reader, injectable so tests never read the real runs directory. */
export type FleetPoolReadingsReader = (pool?: string, root?: string) =>
  Promise<{ readings: PoolReadingView[]; staleAfterSeconds: number }>;
const readReadings: FleetPoolReadingsReader = (pool, root) => showPoolReadings(pool, root);

/** Recorded source labels are externally supplied: strip control/format characters, collapse whitespace, scrub secrets, cap length. */
function oneLine(value: string): string {
  return scrubSecrets(value.replace(/[\p{Cc}\p{Cf}]/gu, ' ')).replace(/\s+/g, ' ').trim().slice(0, 200);
}

export async function cmdFleetPoolReadings(args: string[], read: FleetPoolReadingsReader = readReadings): Promise<number> {
  let json = false;
  let pool: string | undefined;
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') { console.log(HELP); return 0; }
    if (arg === '--json') { if (json) { console.error(usage); return 2; } json = true; continue; }
    if (arg.startsWith('-')) { console.error(`error: unknown option ${oneLine(arg)}\n${usage}`); return 2; }
    if (pool !== undefined) { console.error(`error: expected at most one pool, got ${oneLine(pool)} and ${oneLine(arg)}\n${usage}`); return 2; }
    pool = arg;
  }
  if (pool !== undefined && !POOL_NAME_PATTERN.test(pool)) {
    console.error(`error: pool name must be 1-40 lowercase letters, digits or hyphens\n${usage}`);
    return 2;
  }
  let result: { readings: PoolReadingView[]; staleAfterSeconds: number };
  try {
    result = await read(pool);
  } catch {
    console.error('error: pool readings unavailable');
    return 1;
  }
  if (json) {
    console.log(JSON.stringify(sanitizePublicJson(result)));
    return 0;
  }
  const lines = result.readings.map(view => {
    const label = view.reading
      ? `${view.reading.pct}% used · age ${view.ageSeconds}s · ${oneLine(view.reading.src)}`
      : `${view.error ?? 'reading unavailable'} · age unknown`;
    return `${view.pool}: ${label} · ${view.stale ? 'stale' : 'fresh'} (stale after ${result.staleAfterSeconds / 3600}h)`;
  });
  console.log(lines.join('\n') || 'No readings recorded.');
  return 0;
}
