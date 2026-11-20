/** `phm queue dupcheck <job-id|prompt-file> [--gate] [--json]` and `--stats`: thin handler; logic lives in core/queue/. */
import { DupcheckInputError, dupcheckJob, dupcheckLines } from '../core/queue/dupcheck.js';
import { dupcheckGate, dupcheckStatsLines, readDupcheckStats, recordDupcheckGate } from '../core/queue/dupcheck-gate.js';
import { defaultRunsDir } from '../core/fleet/landed-closes-read.js';

const help = `Usage: phm queue dupcheck <job-id|prompt-file> [--gate] [--json]
       phm queue dupcheck --stats [--json]
Before launching a job: is its work already on master? Reads the goal, pulls out the commands (phm foo bar),
flags, file paths and panel names it names, and looks each up in the CLI command list, docs/CLI-REFERENCE.md,
the file tree and the pull requests merged in the last 7 days in the local job records.
Prints likely_done, partial, new or unknown, with the matching file or PR. unknown means the goal names
nothing to look up. A job id is read from queue/ready.tsv; a prompt file is read as given.
--gate is what the dispatcher runs before it claims a row: skip (high confidence it is done: not launched, reason
and evidence recorded), warn (medium: launch with a "Check this first" line) or launch. It appends one row to
metrics/dupcheck.jsonl. --stats counts skips, warned and plain launches, launches that ended empty as
already_done (recorded by phm jobs empty --record) and skips that were relaunched.
--json prints the report (queue.dupcheck.v1), the gate (queue.dupcheck-gate.v1) or the stats (queue.dupcheck-stats.v1).
Plain check and --stats are read-only; exit 0 for any verdict, 1 when the job, prompt or record cannot be read, 2 for bad usage.`;

export async function cmdQueueDupcheck(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(help); return 0; }
  const json = args.includes('--json'), gate = args.includes('--gate'), stats = args.includes('--stats');
  const rest = args.filter(a => a !== '--json' && a !== '--gate' && a !== '--stats');
  const flags = args.length - rest.length;
  const fail = (message: string): number => { if (json) console.log(JSON.stringify({ error: message })); else console.error(message); return 1; };
  if (stats) {
    if (rest.length || gate || flags !== 1 + (json ? 1 : 0)) { console.error(help); return 2; }
    const s = await readDupcheckStats(defaultRunsDir());
    if (!s) return fail('The dupcheck record (metrics/dupcheck.jsonl) could not be read, so the counts are unknown.');
    console.log(json ? JSON.stringify(s) : dupcheckStatsLines(s).join('\n'));
    return 0;
  }
  if (rest.length !== 1 || rest[0]!.startsWith('-') || flags !== (json ? 1 : 0) + (gate ? 1 : 0)) { console.error(help); return 2; }
  try {
    const report = await dupcheckJob(rest[0]!);
    if (gate) {
      const decision = dupcheckGate(report);
      await recordDupcheckGate(defaultRunsDir(), decision);
      console.log(json ? JSON.stringify(decision) : [`${decision.action} (${decision.confidence} confidence)`, decision.summary, ...(decision.line ? [decision.line] : [])].join('\n'));
    } else console.log(json ? JSON.stringify(report) : dupcheckLines(report).join('\n'));
    return 0;
  } catch (error) {
    return fail(error instanceof DupcheckInputError ? error.message : 'Duplicate check failed.');
  }
}
