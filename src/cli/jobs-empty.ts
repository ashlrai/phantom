import { EMPTY_CLASSES, readEmptyJobs } from '../core/fleet/empty-jobs.js';

const usage = 'Usage: phm jobs empty [--json] [--since <hours>h] | phm jobs retry-empty --dry-run|--apply [--json] [--file <router-queue.md>]';
export async function cmdJobs(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(usage); return 0; }
  if (args[0] === 'retry-empty') return (await import('./jobs-retry-empty.js')).cmdJobsRetryEmpty(args.slice(1));
  if (args[0] !== 'empty') { console.error(usage); return 2; }
  let hours = 24;
  let json = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--json') json = true;
    else if (args[i] === '--help' || args[i] === '-h') { console.log(usage); return 0; }
    else if (args[i] === '--since') {
      const match = /^(\d+(?:\.\d+)?)h$/.exec(args[++i] ?? '');
      if (!match || Number(match[1]) <= 0 || Number(match[1]) > 8760) { console.error(usage); return 2; }
      hours = Number(match[1]);
    } else { console.error(usage); return 2; }
  }
  const report = await readEmptyJobs(hours);
  if (!report) { console.error('Jobs ledger is unreadable.'); return 1; }
  if (json) console.log(JSON.stringify(report));
  else {
    console.log(`${report.total} empty jobs in the last ${hours} hours`);
    for (const kind of EMPTY_CLASSES) console.log(`${kind}: ${report.counts[kind]}`);
    for (const job of report.jobs) console.log(`${job.id} (${job.lane}): ${job.reason}`);
  }
  return 0;
}
