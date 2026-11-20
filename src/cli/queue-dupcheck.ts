/** `phm queue dupcheck <job-id|prompt-file> [--json]`: thin handler; the check lives in core/queue/dupcheck.ts. */
import { DupcheckInputError, dupcheckJob, dupcheckLines } from '../core/queue/dupcheck.js';

const help = `Usage: phm queue dupcheck <job-id|prompt-file> [--json]
Before launching a job: is its work already on master? Reads the goal, pulls out the commands (phm foo bar),
flags, file paths and panel names it names, and looks each up in the CLI command list, docs/CLI-REFERENCE.md,
the file tree and the pull requests merged in the last 7 days in the local job records.
Prints likely_done, partial, new or unknown, with the matching file or PR. unknown means the goal names
nothing to look up. A job id is read from queue/ready.tsv; a prompt file is read as given.
--json prints the report (schema queue.dupcheck.v1). Read-only and offline; exit 0 for any verdict,
1 when the job or prompt cannot be read, 2 for bad usage.`;

export async function cmdQueueDupcheck(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(help); return 0; }
  const json = args.includes('--json');
  const rest = args.filter(a => a !== '--json');
  if (rest.length !== 1 || rest[0]!.startsWith('-') || args.length - rest.length > 1) { console.error(help); return 2; }
  try {
    const report = await dupcheckJob(rest[0]!);
    console.log(json ? JSON.stringify(report) : dupcheckLines(report).join('\n'));
    return 0;
  } catch (error) {
    const message = error instanceof DupcheckInputError ? error.message : 'Duplicate check failed.';
    if (json) console.log(JSON.stringify({ error: message })); else console.error(message);
    return 1;
  }
}
