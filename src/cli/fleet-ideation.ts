import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ideationSchedule, runIdeation } from '../core/research/ideation-loop.js';

const usage = 'phm fleet ideation tick|complete|schedule --config <absolute.json> [--day YYYY-MM-DD --file <output.json>] [--apply] [--json]';
export async function cmdFleetIdeation(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return 0; }
  const [verb, ...rest] = args;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (flags.has(flag) || !['--config', '--day', '--file', '--apply', '--json'].includes(flag)) return 2;
    if (['--apply', '--json'].includes(flag)) flags.set(flag, 'true');
    else { const value = rest[++i]; if (!value || value.startsWith('--')) return 2; flags.set(flag, value); }
  }
  const config = flags.get('--config');
  if (!config || !['tick', 'complete', 'schedule'].includes(verb!) || (verb !== 'complete' && (flags.has('--day') || flags.has('--file'))) || (verb === 'complete' && (!flags.has('--day') || !flags.has('--file'))) || (verb === 'schedule' && flags.has('--apply'))) { console.error(usage); return 2; }
  try {
    const result = verb === 'schedule'
      ? ideationSchedule(resolve(config), fileURLToPath(new URL('../../bin/ashlr', import.meta.url)))
      : await runIdeation(resolve(config), verb as 'tick' | 'complete', { apply: flags.has('--apply'), day: flags.get('--day'), file: flags.get('--file') });
    console.log(JSON.stringify(result)); return 0;
  } catch { console.error('ideation: input, admission, Stop, or queue transaction refused; no model or credential call was made by this command'); return 1; }
}
