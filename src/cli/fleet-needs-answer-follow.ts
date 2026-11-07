import { NEEDS_MASON_ANSWER_ID, readNeedsMasonAnswer } from '../core/fleet/needs-mason-answer.js';
import { isAwaitMs } from '../core/fleet/needs-mason-answer-await.js';
import {
  followNeedsMasonAnswers, NEEDS_ANSWER_FOLLOW_DEFAULT_POLL_MS, NEEDS_ANSWER_FOLLOW_MAX_IDS,
  NEEDS_ANSWER_FOLLOW_MAX_POLL_MS, NEEDS_ANSWER_FOLLOW_MAX_TIMEOUT_MS,
  type NeedsAnswerFollowDeps, type NeedsAnswerFollowRecord, type NeedsAnswerFollowResult,
} from '../core/fleet/needs-mason-answer-follow.js';
import { scrubSecrets } from '../core/util/scrub.js';

const usage = `Usage: ashlr fleet needs-answer-follow <nm-id>... --timeout-ms N [--poll-ms N] [--bus-root DIR] --json
  Emit one NDJSON record per retained needs-you answer as soon as it lands, then one terminal record.
  --timeout-ms N  Bound the whole feed (1..${NEEDS_ANSWER_FOLLOW_MAX_TIMEOUT_MS}); exit 3 with pending ids on timeout, 130 if interrupted.
  --poll-ms N     Scan every N ms (1..${NEEDS_ANSWER_FOLLOW_MAX_POLL_MS}, default ${NEEDS_ANSWER_FOLLOW_DEFAULT_POLL_MS}); needs --timeout-ms.
  --bus-root DIR  Read the bus inbox under DIR (default: ASHLR_HOME/fleet).`;

const MS = /^[1-9][0-9]{0,15}$/;
const EXIT: Record<NeedsAnswerFollowResult['outcome'], number> = { complete: 0, timeout: 3, cancelled: 130, unavailable: 1, invalid: 2 };

interface FollowCliDeps {
  /** Receives one scrubbed NDJSON line per record. */
  emit?: (line: string) => void | Promise<void>;
  read?: typeof readNeedsMasonAnswer;
  now?: NeedsAnswerFollowDeps['now'];
  sleep?: NeedsAnswerFollowDeps['sleep'];
}

/** Convention-resolved CLI entry. Writes the scrubbed follow feed; replies are
 * data only and the bus store is never modified. */
export async function cmdFleetNeedsAnswerFollow(args: string[], deps: FollowCliDeps = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  const ids: string[] = [];
  let root: string | undefined, json = false, timeoutMs: number | undefined, pollMs: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!, next = args[i + 1];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--bus-root' && root === undefined && next !== undefined && next !== '' && !next.startsWith('-') && !next.includes('\0')) { root = next; i++; }
    else if ((arg === '--timeout-ms' || arg === '--poll-ms') && next !== undefined && MS.test(next) &&
        (arg === '--timeout-ms' ? timeoutMs === undefined : pollMs === undefined)) {
      const value = Number(next);
      if (!isAwaitMs(value, arg === '--timeout-ms' ? NEEDS_ANSWER_FOLLOW_MAX_TIMEOUT_MS : NEEDS_ANSWER_FOLLOW_MAX_POLL_MS)) { process.stderr.write(`${usage}\n`); return 2; }
      if (arg === '--timeout-ms') timeoutMs = value; else pollMs = value;
      i++;
    }
    else if (NEEDS_MASON_ANSWER_ID.test(arg) && !ids.includes(arg)) ids.push(arg);
    else { process.stderr.write(`${usage}\n`); return 2; }
  }
  if (!json || timeoutMs === undefined || ids.length < 1 || ids.length > NEEDS_ANSWER_FOLLOW_MAX_IDS) {
    process.stderr.write(`${usage}\n`); return 2;
  }
  const controller = new AbortController(), stop = (): void => controller.abort();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const write = deps.emit ?? ((line: string) => console.log(line));
    const emit = async (record: NeedsAnswerFollowRecord): Promise<void> => { await write(scrubSecrets(JSON.stringify(record))); };
    const result = await followNeedsMasonAnswers(
      { ids, timeoutMs, pollMs, root, signal: controller.signal },
      { read: deps.read, emit, now: deps.now, sleep: deps.sleep });
    return EXIT[result.outcome];
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
}
