import { sweepStale } from '../core/intent/sweep.js';

const usage = 'Usage: ashlr fleet intent-sweep [--apply] [--now <ISO>] [--json]';

export async function cmdFleetIntentSweep(args: string[], deps: { output?: (text: string) => void; error?: (text: string) => void } = {}): Promise<number> {
  const output = deps.output ?? ((text: string) => console.log(text));
  const error = deps.error ?? ((text: string) => process.stderr.write(text));
  let apply = false;
  let json = false;
  let now: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply' && !apply) apply = true;
    else if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--now' && now === undefined && args[i + 1] && !args[i + 1]!.startsWith('--')) now = args[++i];
    else { error(`${usage}\n`); return 2; }
  }
  try {
    const result = await sweepStale({ apply, now });
    output(json ? JSON.stringify(result) : [
      ...result.stale.map(row => `${row.id} ${row.status} ${row.action}`),
      `${result.stale.length} overdue; ${result.updated} refreshed locally.`,
    ].join('\n'));
    return 0;
  } catch (caught) {
    error(`error: ${caught instanceof Error ? caught.message : 'intent sweep failed'}\n`);
    return 1;
  }
}
