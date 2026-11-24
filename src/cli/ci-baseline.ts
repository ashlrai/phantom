import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { analyzeCiBaseline, applyBaselineUpdates, enqueueBaselineFixes } from '../core/fleet/ci-baseline.js';
import { readCiReruns } from '../core/fleet/ci-rerun.js';

const USAGE = 'usage: phm ci baseline [--repo owner/repo] [--json] [--queue] [--queue-file /absolute/path] [--apply] | phm ci reruns [--json]';

export async function cmdCiBaseline(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  if (args[0] === 'reruns') {
    if (args.slice(1).some(arg => arg !== '--json')) { console.error(USAGE); return 2; }
    const { recent, counts, lastHour, recurringFlakes, verdicts } = readCiReruns();
    console.log(JSON.stringify({ recent, counts, lastHour, recurringFlakes, verdicts }, null, 2));
    return 0;
  }
  if (args.shift() !== 'baseline') { console.error(USAGE); return 2; }
  let repo = 'ashlrai/phantom', queueFile = join(homedir(), '.ashlr-runs/queue/router-queue.md');
  let queue = false, apply = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--repo' || arg === '--queue-file') {
      const value = args[++i];
      if (!value || value.startsWith('-')) { console.error(USAGE); return 2; }
      if (arg === '--repo') repo = value; else queueFile = value;
    } else if (arg === '--queue') queue = true;
    else if (arg === '--apply') apply = true;
    else if (arg !== '--json') { console.error(USAGE); return 2; }
  }
  if (!isAbsolute(queueFile) || !/^[\w-][\w.-]*\/[\w-][\w.-]*$/.test(repo)) { console.error(USAGE); return 2; }
  try {
    const report = await analyzeCiBaseline(repo);
    const queued = queue ? enqueueBaselineFixes(report, queueFile) : [];
    const applied = apply ? await applyBaselineUpdates(report) : [];
    console.log(JSON.stringify({ ...report, queued, applied, dryRun: !apply }, null, 2));
    return 0;
  } catch { console.error('ci baseline: unable to complete'); return 1; }
}
