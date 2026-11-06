import { NEEDS_MASON_ANSWER_ID, readNeedsMasonAnswer } from '../core/fleet/needs-mason-answer.js';
import {
  awaitNeedsMasonAnswer, isAwaitMs, NEEDS_MASON_AWAIT_DEFAULT_POLL_MS, NEEDS_MASON_AWAIT_MAX_POLL_MS,
  NEEDS_MASON_AWAIT_MAX_TIMEOUT_MS, type NeedsMasonAwaitDeps, type NeedsMasonAwaitResult,
} from '../core/fleet/needs-mason-answer-await.js';
import { scrubSecrets } from '../core/util/scrub.js';

const usage = `Usage: ashlr fleet needs-answer <nm-id> [--json] [--bus-root DIR] [--timeout-ms N [--poll-ms N] [--stop-file PATH]]
  --bus-root DIR  Read the bus inbox under DIR (default: ASHLR_HOME/fleet).
  --timeout-ms N  Wait up to N ms (1..${NEEDS_MASON_AWAIT_MAX_TIMEOUT_MS}) for the answer; exit 3 on timeout, 130 if interrupted.
  --poll-ms N     Poll every N ms (1..${NEEDS_MASON_AWAIT_MAX_POLL_MS}, default ${NEEDS_MASON_AWAIT_DEFAULT_POLL_MS}); needs --timeout-ms.
  --stop-file PATH  Cancel the wait (exit 130) once PATH exists; checked at most every 250 ms, never read or modified; needs --timeout-ms.`;

const MS = /^[1-9][0-9]{0,15}$/;
const EXIT: Record<NeedsMasonAwaitResult['status'], number> = { found: 0, unknown: 1, unavailable: 1, invalid: 2, timeout: 3, cancelled: 130 };

/** Wait with SIGINT/SIGTERM mapped to an abort; the handlers never outlive the wait. */
async function awaitWithSignals(itemId: string, options: { root?: string; timeoutMs: number; pollMs?: number; stopFile?: string },
    deps: NeedsMasonAwaitDeps): Promise<NeedsMasonAwaitResult> {
  const controller = new AbortController(), stop = (): void => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try { return await awaitNeedsMasonAnswer(itemId, { ...options, signal: controller.signal }, deps); }
  finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}

/** Convention-resolved CLI entry. Prints Mason's retained needs-you answer; the
 * reply is data only and the bus store is never modified. */
export async function cmdFleetNeedsAnswer(args: string[], deps: { read?: typeof readNeedsMasonAnswer; now?: NeedsMasonAwaitDeps['now']; sleep?: NeedsMasonAwaitDeps['sleep']; stat?: NeedsMasonAwaitDeps['stat'] } = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let itemId: string | undefined, root: string | undefined, json = false, timeoutMs: number | undefined, pollMs: number | undefined, stopFile: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!, next = args[i + 1];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--bus-root' && root === undefined && next !== undefined && !next.startsWith('-')) { root = next; i++; }
    else if (arg === '--stop-file' && stopFile === undefined && next !== undefined && next !== '' && !next.startsWith('-') && !next.includes('\0')) { stopFile = next; i++; }
    else if ((arg === '--timeout-ms' || arg === '--poll-ms') && next !== undefined && MS.test(next) &&
        (arg === '--timeout-ms' ? timeoutMs === undefined : pollMs === undefined)) {
      const value = Number(next);
      if (!isAwaitMs(value, arg === '--timeout-ms' ? NEEDS_MASON_AWAIT_MAX_TIMEOUT_MS : NEEDS_MASON_AWAIT_MAX_POLL_MS)) { process.stderr.write(`${usage}\n`); return 2; }
      if (arg === '--timeout-ms') timeoutMs = value; else pollMs = value;
      i++;
    }
    else if (NEEDS_MASON_ANSWER_ID.test(arg) && itemId === undefined) itemId = arg;
    else { process.stderr.write(`${usage}\n`); return 2; }
  }
  if (!itemId || ((pollMs !== undefined || stopFile !== undefined) && timeoutMs === undefined)) { process.stderr.write(`${usage}\n`); return 2; }
  let result: NeedsMasonAwaitResult;
  if (timeoutMs !== undefined) result = await awaitWithSignals(itemId, { root, timeoutMs, pollMs, stopFile }, deps);
  else {
    try { result = (deps.read ?? readNeedsMasonAnswer)(itemId, { root }); }
    catch { result = { status: 'unavailable' }; }
  }
  if (json) {
    console.log(scrubSecrets(JSON.stringify(result.status === 'found'
      ? { v: 1, status: 'found', itemId, id: result.id, cursor: result.cursor, receivedAt: result.receivedAt, answer: result.answer }
      : { v: 1, status: result.status, itemId })));
  } else if (result.status === 'found') {
    const { answer } = result;
    console.log(scrubSecrets([
      `${itemId} answered via ${answer.source} at ${answer.resolvedAt} (bus cursor ${result.cursor})`,
      `item: ${answer.item}`,
      `reply: ${answer.reply ?? '(no reply text)'}`,
    ].join('\n')));
  } else if (result.status === 'unavailable') process.stderr.write('error: needs-answer unavailable\n');
  else console.log(`${result.status} ${itemId}`);
  return EXIT[result.status];
}
