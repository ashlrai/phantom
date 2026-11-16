import { homedir } from 'node:os';
import { join } from 'node:path';
import { recordOutputEval, reportOutputEval } from '../core/fleet/output-eval.js';

const usage = 'Usage: phm fleet output-eval <record|report> [--jobs <jobs.jsonl>] [--store <file>] [--json]';
export async function cmdFleetOutputEval(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  const verb = args[0];
  if (verb !== 'record' && verb !== 'report') { console.error(usage); return 2; }
  let jobs = join(homedir(), '.ashlr-runs', 'metrics', 'jobs.jsonl'), store: string | undefined;
  let json = false, seenJobs = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--jobs' && verb === 'record' && !seenJobs && args[i + 1] && !args[i + 1]!.startsWith('--')) { jobs = args[++i]!; seenJobs = true; }
    else if (args[i] === '--store' && store === undefined && args[i + 1] && !args[i + 1]!.startsWith('--')) store = args[++i]!;
    else { console.error(usage); return 2; }
  }
  try {
    const result = verb === 'record' ? await recordOutputEval(jobs, store) : await reportOutputEval(store);
    console.log(JSON.stringify(result, null, json ? undefined : 2)); return 0;
  } catch { console.error('error: unable to read or write output evaluation'); return 1; }
}
