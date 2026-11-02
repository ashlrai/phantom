/** `phm app outcome list|retry`: the CLI twin of the Work for me screen. Thin; logic lives in src/core/verse. */
import { executeOutcomeOperation } from '../core/verse/outcomes-operations.js';
import { OUTCOME_ID_PATTERN, type OutcomeView } from '../core/verse/outcomes-api-types.js';

const USAGE = 'Usage: phm app outcome list [--json] | phm app outcome retry <id> [--json]';
const HELP = `${USAGE}
list   Show each saved outcome with its status, last error and whether a retry is possible.
retry  Re-plan an outcome that has no plan or a failed task. Past attempts stay on record.
Exit 0 ok, 1 refused or unavailable, 2 invalid arguments.`;
const REFUSED: Record<string, string> = {
  invalid: 'Nothing to retry: the outcome is paused, still running, or has no failed task or missing plan.',
  conflict: 'The outcome changed while retrying. Run the command again.',
  held: 'Outcome storage is busy. Run the command again.',
  'unknown-source': 'Outcome or enrollment records are unavailable.',
  'storage-failed': 'The retry could not be confirmed. Run the command again.',
  unenrolled: 'The outcome targets a repository that is no longer enrolled.',
};

function line(outcome: OutcomeView): string {
  const error = outcome.lastError ? ` - ${outcome.lastError.message}` : '';
  return `${outcome.id}  ${outcome.status}${error}${outcome.retryable ? `  (retry: phm app outcome retry ${outcome.id})` : ''}`;
}

export async function cmdApp(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(HELP); return 0; }
  const json = args.includes('--json');
  const [area, verb, id, ...extra] = args.filter(arg => arg !== '--json');
  const bad = (): number => { console.error(`error: invalid app arguments\n${USAGE}`); return 2; };
  const print = (value: unknown, text: string): void => console.log(json ? JSON.stringify(value) : text);
  if (area !== 'outcome') return bad();
  const read = executeOutcomeOperation({ kind: 'read' });
  if (!('outcomes' in read) || read.outcomes === null) {
    print({ ok: false, reason: 'unknown-source', error: REFUSED['unknown-source'] }, `error: ${REFUSED['unknown-source']}`);
    return 1;
  }
  if (verb === 'list' && id === undefined) {
    print({ ok: true, outcomes: read.outcomes }, read.outcomes.length ? read.outcomes.map(line).join('\n') : 'No saved outcomes.');
    return 0;
  }
  if (verb !== 'retry' || !id || extra.length || !OUTCOME_ID_PATTERN.test(id)) return bad();
  const current = read.outcomes.find(outcome => outcome.id === id);
  if (!current) { print({ ok: false, reason: 'invalid', error: `No outcome named ${id}.` }, `error: No outcome named ${id}.`); return 1; }
  // One command id per revision: running it twice replays instead of re-planning twice.
  const result = executeOutcomeOperation({ kind: 'retry', id, commandId: `retry-r${current.revision}`, expectedRevision: current.revision });
  if (!('ok' in result)) return bad();
  if (!result.ok) { print({ ok: false, reason: result.reason, error: REFUSED[result.reason] }, `error: ${REFUSED[result.reason]}`); return 1; }
  print({ ok: true, disposition: result.disposition, outcome: result.outcome },
    `${result.disposition === 'replayed' ? 'Retry already recorded' : 'Retry recorded'}: ${line(result.outcome)}`);
  return 0;
}
