/**
 * `ashlr fleet reset-follow` — bounded read-only tail of the reset-release
 * audit while the desktop is closed: one JSONL record per newly recorded
 * release newer than the exclusive --after watermark (default: invocation
 * time), then one terminal summary. Emits only `fleet reset-history`'s public
 * fields — never raw audit reasons — and writes nothing.
 */
import { isAbsolute } from 'node:path';
import { isAwaitMs } from '../core/fleet/needs-mason-answer-await.js';
import {
  RESET_FOLLOW_DEFAULT_POLL_MS, RESET_FOLLOW_MAX_POLL_MS, RESET_FOLLOW_MAX_TIMEOUT_MS,
  RESET_FOLLOW_SOURCE_LIMIT, followResetReleases,
  type ResetFollowDeps, type ResetFollowRecord,
} from '../core/fleet/reset-history-follow.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: ashlr fleet reset-follow --timeout-ms N [--poll-ms N] [--after ISO_TIMESTAMP] [--lane NAME] [--runs-dir ABS] --json
  --timeout-ms N  Bound the whole follow (1..${RESET_FOLLOW_MAX_TIMEOUT_MS}); required.
  --poll-ms N     Read interval (1..${RESET_FOLLOW_MAX_POLL_MS}, default ${RESET_FOLLOW_DEFAULT_POLL_MS}); each sleep is capped by the time left.
  --after ISO_TIMESTAMP  Emit only releases recorded after this exclusive watermark (default: invocation time).
  --lane NAME     Emit only releases for lane NAME.
  --runs-dir ABS  Dispatch runs dir (default ASHLR_RUNS_DIR or ~/.ashlr-runs).
  --json          Required: one JSONL record per newly recorded release plus one terminal summary.
  ${RESET_FOLLOW_SOURCE_LIMIT}.
  Exit: 0 deadline, 1 failed, 2 bad arguments, 130 cancelled.`;

interface FollowCliDeps extends Pick<ResetFollowDeps, 'read' | 'now' | 'wallNow' | 'sleep'> {
  /** Receives one scrubbed JSONL line per record, including the summary. */
  emit?: (line: string) => void | Promise<void>;
  signal?: AbortSignal;
}
const MS = /^[1-9][0-9]{0,15}$/;

export async function cmdFleetResetFollow(args: string[], deps: FollowCliDeps = {}): Promise<number> {
  const write = deps.emit ?? ((text: string) => console.log(text));
  const invalid = (): number => { process.stderr.write(`${usage}\n`); return 2; };
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { await write(usage); return 0; }
  let json = false, timeoutMs: number | undefined, pollMs: number | undefined,
      runsDir: string | undefined, lane: string | undefined, after: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!, next = args[i + 1];
    if (arg === '--json' && !json) { json = true; continue; }
    if (arg === '--runs-dir' && runsDir === undefined && next !== undefined && isAbsolute(next) && !next.includes('\0')) { runsDir = next; i++; continue; }
    if (arg === '--lane' && lane === undefined && next !== undefined && next !== '' && !next.startsWith('-') && !next.includes('\0')) { lane = next; i++; continue; }
    if (arg === '--after' && after === undefined && next !== undefined && Number.isFinite(Date.parse(next))) { after = next; i++; continue; }
    if ((arg === '--timeout-ms' || arg === '--poll-ms') && next !== undefined && MS.test(next)
        && (arg === '--timeout-ms' ? timeoutMs === undefined : pollMs === undefined)) {
      const value = Number(next);
      if (!isAwaitMs(value, arg === '--timeout-ms' ? RESET_FOLLOW_MAX_TIMEOUT_MS : RESET_FOLLOW_MAX_POLL_MS)) return invalid();
      if (arg === '--timeout-ms') timeoutMs = value; else pollMs = value;
      i++; continue;
    }
    return invalid();
  }
  if (timeoutMs === undefined || !json) return invalid();
  const emit = async (record: ResetFollowRecord): Promise<void> => {
    await write(JSON.stringify(sanitizePublicJson(record)));
  };
  const result = await followResetReleases(
    { timeoutMs, pollMs, after, lane, runsDir, signal: deps.signal },
    { read: deps.read, emit, now: deps.now, wallNow: deps.wallNow, sleep: deps.sleep });
  return result.outcome === 'deadline' ? 0 : result.outcome === 'cancelled' ? 130
    : result.outcome === 'invalid' ? 2 : 1;
}
