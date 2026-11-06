import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { planCiDaily } from '../core/fleet/ci-daily-plan.js';

/** Read-only owner handoff; patch mode emits no prose on stdout. */
export async function cmdFleetCiPlan(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: ashlr fleet ci-plan [--patch | --json] [--cron "expr"]');
    return;
  }
  const cronIndex = args.indexOf('--cron');
  if (args.some((arg, index) => !['--patch', '--json', '--cron'].includes(arg) && !(cronIndex >= 0 && index === cronIndex + 1))
    || (cronIndex >= 0 && (!args[cronIndex + 1] || args[cronIndex + 1]!.startsWith('--')))
    || (args.includes('--patch') && args.includes('--json'))) {
    console.error('Usage: ashlr fleet ci-plan [--patch | --json] [--cron "expr"]');
    process.exitCode = 2;
    return;
  }
  const folder = join(process.cwd(), '.github', 'workflows');
  let entries;
  try { entries = await readdir(folder, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    console.error('Workflow folder is missing.');
    process.exitCode = 2;
    return;
  }
  const files = await Promise.all(entries.filter(entry => entry.isFile() && /\.ya?ml$/.test(entry.name)).map(async entry => ({
    file: `.github/workflows/${entry.name}`, text: await readFile(join(folder, entry.name), 'utf8'),
  })));
  const result = planCiDaily(files, cronIndex >= 0 ? { cron: args[cronIndex + 1] } : undefined);
  process.exitCode = result.plans.length ? 0 : 2;
  if (args.includes('--patch')) process.stdout.write(result.patch);
  else if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(['file\taction\tremoved\tkept\tcron', ...result.plans.map(plan =>
      `${plan.file}\t${plan.action}\t${plan.removed.join(',') || '-'}\t${plan.kept.join(',') || '-'}\t${plan.cron ?? '-'}`)].join('\n'));
    console.log(`\n${result.summary}\n\n${result.followUps.join('\n\n')}`);
    for (const plan of result.plans.filter(plan => plan.action === 'skip')) console.log(`${plan.file}: ${plan.reason}`);
  }
}
