import { homedir } from 'node:os';
import { join } from 'node:path';
import { dedupeQueueFile } from '../core/queue/dedupe.js';

const help = `Usage: phm queue dedupe [--file <router-queue.md>] [--apply] [--json]
Find repeated READY jobs in the router queue. The first READY or CLAIMED job wins.
By default, only show the count and IDs. Add --apply to mark repeats as superseded.
Jobs missing a repo, target file or acceptance text are unknown and left alone.`;
export async function cmdQueueDedupe(args: string[]): Promise<number> {
  let file = join(process.env.ASHLR_RUNS_DIR || join(homedir(), '.ashlr-runs'), 'queue', 'router-queue.md');
  let apply = false, json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') { console.log(help); return 0; }
    if (args[i] === '--apply') apply = true;
    else if (args[i] === '--json') json = true;
    else if (args[i] === '--file' && args[i + 1] && !args[i + 1]!.startsWith('--')) file = args[++i]!;
    else { console.error(help); return 2; }
  }
  try {
    const report = await dedupeQueueFile(file, apply);
    if (json) console.log(JSON.stringify(report));
    else {
      console.log(`${report.count} repeats${report.applied ? ' marked superseded' : ' (preview)'}.`);
      for (const row of report.repeats) console.log(`${row.id} repeats ${row.repeatOf}`);
      console.log(`Unknown: ${report.unknown.length}`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Queue unavailable';
    if (json) console.log(JSON.stringify({ error: message })); else console.error(message);
    return 1;
  }
}
