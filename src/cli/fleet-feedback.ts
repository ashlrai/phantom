import { isAbsolute } from 'node:path';
import { runFeedback } from '../core/fleet/feedback-cycle.js';

const usage = 'Usage: phm fleet feedback scan [--apply] [--days 1..30] [--runs-dir <absolute>] [--json]\n       phm fleet feedback digest [--days 1..30] [--runs-dir <absolute>] [--json]';
export async function cmdFleetFeedback(args: string[], deps = { run: runFeedback }): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  const [command, ...flags] = args;
  let days = 7, runsDir: string | undefined, apply = false;
  const seen = new Set<string>();
  try {
    if (command !== 'scan' && command !== 'digest') throw new Error();
    for (let i = 0; i < flags.length; i++) {
      const flag = flags[i]!;
      if (seen.has(flag)) throw new Error();
      seen.add(flag);
      if (flag === '--json') continue;
      if (flag === '--apply' && command === 'scan') { apply = true; continue; }
      const value = flags[++i];
      if (!value) throw new Error();
      if (flag === '--days' && /^\d{1,2}$/.test(value) && Number(value) >= 1 && Number(value) <= 30) days = Number(value);
      else if (flag === '--runs-dir' && isAbsolute(value)) runsDir = value;
      else throw new Error();
    }
  } catch { console.error(usage); return 2; }
  try {
    const result = await deps.run({ command: command as 'scan' | 'digest', apply, days, runsDir });
    console.log(JSON.stringify(result, null, seen.has('--json') ? undefined : 2));
    return result.errors.length || Object.values(result.sources).some(status => status !== 'ok') ? 1 : 0;
  } catch { console.log(JSON.stringify({ schema: 'fleet.feedback.v1', error: 'feedback-unavailable' })); return 1; }
}
