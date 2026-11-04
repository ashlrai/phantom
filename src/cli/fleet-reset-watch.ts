/**
 * `ashlr fleet reset-watch` — bounded repetition of runResetReleaseOnce while
 * the desktop is closed: one pass now, then one per --poll-ms until --timeout-ms,
 * a --stop-file appears or a signal lands. One sanitized line per completed
 * pass (JSONL under --json), then a summary naming deadline, cancelled or
 * failed. Manual-hold protections live entirely inside runResetReleaseOnce.
 */
import { isAbsolute } from 'node:path';
import { isAwaitMs } from '../core/fleet/needs-mason-answer-await.js';
import {
  RESET_WATCH_MAX_POLL_MS, RESET_WATCH_MAX_TIMEOUT_MS, watchResetReleases,
  type ResetWatchDeps, type ResetWatchRecord,
} from '../core/fleet/reset-release-watch.js';
import { createResetWatchPublisher } from '../core/fleet/reset-watch-bus.js';
import { appendBusInbox } from '../core/fleet/bus-inbox.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: ashlr fleet reset-watch --timeout-ms N [--poll-ms N] [--runs-dir ABS] [--stop-file PATH] [--bus-root ABS] [--json]
  --timeout-ms N  Bound the whole watch (1..${RESET_WATCH_MAX_TIMEOUT_MS}); required.
  --poll-ms N     Pass interval (1..${RESET_WATCH_MAX_POLL_MS}, default 60000); each sleep is capped by the time left.
  --runs-dir ABS  Dispatch runs dir (default ASHLR_RUNS_DIR or ~/.ashlr-runs).
  --stop-file PATH  Cancel before the next pass once PATH exists; never read or modified.
  --bus-root ABS  Publish watcher state to the shared bus at ABS.
  --json          Emit one JSONL record per completed pass plus a terminal summary.
  Exit: 0 deadline with no pass errors, 1 failed or any lane errors, 2 bad arguments, 130 cancelled.`;

interface WatchCliDeps extends Pick<ResetWatchDeps, 'run' | 'now' | 'sleep' | 'probe'> {
  /** Receives one scrubbed line per record (JSONL under --json). */
  emit?: (line: string) => void | Promise<void>;
  signal?: AbortSignal;
  append?: typeof appendBusInbox;
}
const MS = /^[1-9][0-9]{0,15}$/;

/** One display line per record — counts, lane names and lane errors only. */
const line = (record: ResetWatchRecord): string => {
  if (record.type === 'pass') {
    const head = `fleet reset-watch: ${record.at} · checked ${record.checked}` +
      ` · released ${record.released}${record.lanes.length ? ` (${record.lanes.join(', ')})` : ''}` +
      ` · errors ${record.errors.length}`;
    return record.errors.length === 0 ? head
      : `${head}\n${record.errors.map(e => `  error ${e.lane}: ${e.message}`).join('\n')}`;
  }
  return `fleet reset-watch: ${record.outcome} after ${record.passes} pass(es)` +
    ` · released ${record.released} lane(s) · errors ${record.errors}` +
    (record.lastError === null ? '' : ` · ${record.lastError}`);
};

export async function cmdFleetResetWatch(args: string[], deps: WatchCliDeps = {}): Promise<number> {
  const write = deps.emit ?? ((text: string) => console.log(text));
  const invalid = (): number => { process.stderr.write(`${usage}\n`); return 2; };
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { await write(usage); return 0; }
  let json = false, timeoutMs: number | undefined, pollMs: number | undefined,
      runsDir: string | undefined, stopFile: string | undefined, busRoot: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!, next = args[i + 1];
    if (arg === '--json' && !json) { json = true; continue; }
    if (arg === '--bus-root' && busRoot === undefined && next !== undefined && isAbsolute(next) && !next.includes('\0')) { busRoot = next; i++; continue; }
    if (arg === '--runs-dir' && runsDir === undefined && next !== undefined && isAbsolute(next)) { runsDir = next; i++; continue; }
    if (arg === '--stop-file' && stopFile === undefined && next !== undefined && next !== '' && !next.startsWith('-') && !next.includes('\0')) { stopFile = next; i++; continue; }
    if ((arg === '--timeout-ms' || arg === '--poll-ms') && next !== undefined && MS.test(next)
        && (arg === '--timeout-ms' ? timeoutMs === undefined : pollMs === undefined)) {
      const value = Number(next);
      if (!isAwaitMs(value, arg === '--timeout-ms' ? RESET_WATCH_MAX_TIMEOUT_MS : RESET_WATCH_MAX_POLL_MS)) return invalid();
      if (arg === '--timeout-ms') timeoutMs = value; else pollMs = value;
      i++; continue;
    }
    return invalid();
  }
  if (timeoutMs === undefined) return invalid();
  const publish = busRoot === undefined ? undefined : createResetWatchPublisher(busRoot, deps.append);
  const post = (record: ResetWatchRecord | 'start'): void => {
    if (publish && !publish(record)) process.stderr.write('fleet reset-watch: bus publication unavailable\n');
  };
  post('start');
  const emit = async (record: ResetWatchRecord): Promise<void> => {
    post(record);
    await write(json ? JSON.stringify(sanitizePublicJson(record)) : line(sanitizePublicJson(record) as ResetWatchRecord));
  };
  const result = await watchResetReleases(
    { timeoutMs, pollMs, runsDir, stopFile, signal: deps.signal },
    { run: deps.run, emit, now: deps.now, sleep: deps.sleep, probe: deps.probe });
  return result.outcome === 'cancelled' ? 130
    : result.outcome === 'deadline' && result.errors === 0 ? 0 : 1;
}
