import { readFile } from 'node:fs/promises';
import { mergeQueueAge, type MergeQueueAgeInput } from '../core/fleet/merge-queue-age.js';
import { validMergeAgeInput } from './fleet-merge-age.js';

export { mergeQueueAge };
export type { MergeQueueAgeInput };
const usage = 'Usage: phm fleet merge-queue-age --input <snapshot.json> [--json]\nRead queued PR age, oldest first. Snapshot: {prs:[{number,state?,mergeable?,reviewDecision?}],queue:[{number,enteredAt?,requiredChecks?:[{name,status}]}]}. State: OPEN, MERGED or CLOSED. Check status: success, pending, failure or missing. Merged and closed PRs are excluded; missing evidence stays unknown. Read-only; required checks stay in place.';

export async function cmdFleetMergeQueueAge(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let path: string | undefined, json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--input' && !path && args[i + 1] && !args[i + 1]!.startsWith('-')) path = args[++i];
    else { console.error(usage); return 2; }
  }
  if (!path) { console.error(usage); return 2; }
  try {
    const input: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!validMergeAgeInput(input) || !input.prs.every(pr => {
      const state = (pr as MergeQueueAgeInput['prs'][number]).state;
      return state === undefined || ['OPEN', 'MERGED', 'CLOSED'].includes(state);
    })) throw new Error('Invalid snapshot');
    const report = mergeQueueAge(input);
    if (json) console.log(JSON.stringify(report));
    else if (!report.entries.length) console.log('No queued PRs.');
    else for (const row of report.entries) {
      const reason = [...row.causes.map(cause => cause.action), ...row.missingData.map(field => `Unknown ${field}.`)];
      console.log(`#${row.number}\t${row.ageSeconds === null ? 'unknown age' : `${row.ageSeconds}s queued`}\t${reason.join(' ') || 'Waiting in merge queue.'}`);
    }
    return 0;
  } catch { console.error('error: unable to read valid merge queue snapshot; use --help for its shape'); return 1; }
}
