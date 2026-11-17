import { readEmptyJobs } from '../core/fleet/empty-jobs.js';

const usage = 'Usage: phm jobs empty [--json] [--since <hours>h] [--family F] | phm jobs retry-empty --dry-run|--apply [--json] [--file <router-queue.md>]';
export async function cmdJobs(args: string[], read = readEmptyJobs): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(usage); return 0; }
  if (args[0] === 'retry-empty') return (await import('./jobs-retry-empty.js')).cmdJobsRetryEmpty(args.slice(1));
  if (args[0] !== 'empty') { console.error(usage); return 2; }
  let hours = 24;
  let json = false;
  let family: string | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--json') json = true;
    else if (args[i] === '--help' || args[i] === '-h') { console.log(usage); return 0; }
    else if (args[i] === '--since') {
      const match = /^(\d+(?:\.\d+)?)h$/.exec(args[++i] ?? '');
      if (!match || Number(match[1]) <= 0 || Number(match[1]) > 8760) { console.error(usage); return 2; }
      hours = Number(match[1]);
    } else if (args[i] === '--family' && family === undefined) {
      family = args[++i];
      if (!family || !/^[A-Za-z0-9][A-Za-z0-9._*-]*$/.test(family)) { console.error(usage); return 2; }
    } else { console.error(usage); return 2; }
  }
  const report = await read(hours, undefined, undefined, undefined, { family });
  if (!report) { console.error('Jobs ledger is unreadable.'); return 1; }
  if (json) console.log(JSON.stringify(report));
  else {
    console.log(`${report.total} empty jobs in the last ${hours} hours`);
    for (const [label, groups] of [['Family', report.diagnosis?.families], ['Lane', report.diagnosis?.lanes]] as const) {
      for (const group of groups ?? []) console.log(`${label} ${group.name}: ${group.total} empty; ${group.topReason}; ${group.suggestion}`);
    }
    for (const job of report.diagnosis?.jobs ?? []) console.log(`${job.id} (${job.lane}): ${job.reason}`);
  }
  return 0;
}
