/** `phm queue supersede`: thin handler. The plan and the writes live in core/queue/supersede.ts. */
import { supersedeQueue, supersedeText, type SupersedeOptions, type SupersedeReport } from '../core/queue/supersede.js';

const help = `Usage: phm queue supersede [--json] [--apply]
List queued jobs that a newer cycle of the same job replaces, such as RQ-PHX-RECUTCOREC541 once RQ-PHX-RECUTCOREC544 is queued.
Jobs match when they share a repo and an id that differs only in its cycle (C<number>, <number>S or <number>C at the end).
Ids without a cycle are left alone. Nothing changes unless you add --apply.
  --apply  move the older rows from ready.tsv to superseded.tsv beside it, mark their router-queue.md lines
           SUPERSEDED-BY-<newer id>, and add one SUPERSEDED line per job to dispatch-events.log. Nothing is deleted.
  --json   print the typed report (schema queue.supersede.v1)`;

export async function cmdQueueSupersede(args: string[], run: (opts: SupersedeOptions) => Promise<SupersedeReport> = supersedeQueue): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(help); return 0; }
  if (args.some(arg => arg !== '--json' && arg !== '--apply')) { console.error(help); return 2; }
  const json = args.includes('--json'), apply = args.includes('--apply');
  try {
    const report = await run({ apply });
    console.log(json ? JSON.stringify(report) : supersedeText(report).join('\n'));
    // An apply the dispatcher overwrote is not a success: say so and let the caller run it again.
    if (apply && report.count && !report.applied) { if (!json) console.error('The queue changed while writing. Run it again.'); return 1; }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Queue unavailable';
    if (json) console.log(JSON.stringify({ error: message })); else console.error(message);
    return 1;
  }
}
