import { readFile } from 'node:fs/promises';
import { mergeAge, type MergeAgeInput } from '../core/fleet/merge-age.js';

const usage = 'Usage: phm fleet merge-age --input <snapshot.json> [--json]\nRead-only queue age report. Snapshot: {prs:[{number,mergeable,reviewDecision}],queue:[{number,enteredAt,requiredChecks:[{name,status}]}]}. Checks describe the merge group; omitted data is unknown. No merge or queue changes.';
function valid(value: unknown): value is MergeAgeInput {
  if (!value || typeof value !== 'object') return false;
  const { prs, queue } = value as MergeAgeInput;
  const number = (n: unknown) => Number.isSafeInteger(n) && Number(n) > 0;
  return Array.isArray(prs) && Array.isArray(queue)
    && prs.every(pr => pr && number(pr.number)
      && (pr.mergeable === undefined || ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'].includes(pr.mergeable))
      && (pr.reviewDecision === undefined || ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'].includes(pr.reviewDecision)))
    && queue.every(row => row && number(row.number) && (row.enteredAt === undefined || typeof row.enteredAt === 'string')
      && (row.requiredChecks === undefined || (Array.isArray(row.requiredChecks) && row.requiredChecks.every(check => check
        && typeof check.name === 'string' && check.name.trim() && ['success', 'pending', 'failure', 'missing'].includes(check.status)))));
}
export async function cmdFleetMergeAge(args: string[]): Promise<number> {
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
    if (!valid(input)) throw new Error('Invalid snapshot');
    console.log(JSON.stringify(mergeAge(input), null, json ? undefined : 2));
    return 0;
  } catch { console.error('error: unable to read valid merge-age snapshot; use --help for its shape'); return 1; }
}
