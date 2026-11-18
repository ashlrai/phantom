import { setPoolReading, showPoolReadings } from '../core/usage/pool-reading.js';

export const POOL_READING_HELP = `Usage: phm pool reading set <pool> --pct <0-100> --reset-at <iso|epoch> --source <who/where measured> [--json]
       phm pool reading show [<pool>] [--json]
Unix epochs are seconds. Capture time is set now. Readings are stale after 8h.`;
export async function cmdPoolReading(args: string[]): Promise<number> {
  try {
    const [verb, ...rest] = args;
    let result;
    if (verb === 'show') {
      const positional = rest.filter(a => a !== '--json');
      if (positional.length > 1 || positional.some(a => a.startsWith('-')) || rest.filter(a => a === '--json').length > 1) throw new Error(POOL_READING_HELP);
      result = await showPoolReadings(positional[0]);
    } else if (verb === 'set') {
      const pool = rest.shift(), flags: Record<string, string> = {};
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--json' && !flags['--json']) { flags['--json'] = 'yes'; continue; }
        const flag = rest[i]!;
        if (!['--pct', '--reset-at', '--source'].includes(flag) || flags[flag] !== undefined || rest[i + 1] === undefined) throw new Error(POOL_READING_HELP);
        flags[flag] = rest[++i]!;
      }
      if (!flags['--pct']?.trim()) throw new Error('pct is required');
      result = { readings: [await setPoolReading({ pool, pct: Number(flags['--pct']), reset_at: flags['--reset-at'], source: flags['--source'] })] };
    } else throw new Error(POOL_READING_HELP);
    if (args.includes('--json')) console.log(JSON.stringify(result));
    else console.log(result.readings.map(r => `${r.pool}: ${r.reading ? `${r.reading.pct}% used · age ${r.ageSeconds}s · ${r.reading.src}` : r.error} · ${r.stale ? 'stale' : 'fresh'} (stale after 8h)`).join('\n') || 'No readings recorded.');
    return 0;
  } catch (error) { console.error(error instanceof Error ? error.message : 'Invalid reading'); return 2; }
}
