import { homedir } from 'node:os';
import { join } from 'node:path';
import { diskForecast } from '../core/fleet/disk-forecast.js';
import { readSource } from '../core/fleet/runs-parked-queue.js';

const usage = 'Usage: phm fleet disk-forecast [--storage <disk-growth-history.json>] [--jobs <jobs.jsonl>] [--json]';
export async function cmdFleetDiskForecast(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  const root = process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  let storage = join(root, 'queue', 'disk-growth-history.json'), jobs = join(root, 'metrics', 'jobs.jsonl'), json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) { console.error(usage); return 2; }
    seen.add(arg);
    if (arg === '--json') json = true;
    else if ((arg === '--storage' || arg === '--jobs') && args[i + 1] && !args[i + 1]!.startsWith('--')) {
      if (arg === '--storage') storage = args[++i]!; else jobs = args[++i]!;
    } else { console.error(usage); return 2; }
  }
  const read = async (path: string, tail: boolean): Promise<string | null> => {
    const source = await readSource(path, 5 * 1024 * 1024, tail);
    return source.state === 'healthy' ? source.text : null;
  };
  const [history, ledger] = await Promise.all([read(storage, false), read(jobs, false)]);
  const report = diskForecast(history, ledger);
  console.log(json ? JSON.stringify(report) : `150 GB free: ${report.status === 'projected' ? `projected at ${report.crossingAt}` : report.status === 'reached' ? 'already reached' : report.status === 'not-falling' ? 'not at the observed rate' : 'unknown'}`);
  return 0;
}
