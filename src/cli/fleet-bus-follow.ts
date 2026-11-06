import { listBusInboxAfter } from '../core/fleet/bus-inbox.js';
import { followBusStream, validBusFollowRequest, type BusFollowRecord, type BusFollowRequest } from '../core/fleet/bus-follow-stream.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: ashlr fleet bus-follow --after <nonnegative-safe-cursor> --duration-ms <1..3600000> [--to <exact-address>] [--interval-ms <100..60000>] [--root <absolute>] --json';

interface Dependencies {
  /** Receives one scrubbed JSON line per record; resolves when the line is accepted. */
  emit?: (json: string) => void | Promise<void>;
  list?: typeof listBusInboxAfter;
  signal?: AbortSignal;
  now?: () => number;
  clock?: () => number;
}

function redactFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactFields);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /(?:api[_-]?key|token|secret|password|passwd|pwd|credentials?|private[_-]?key|access[_-]?key|auth(?:orization)?|connection[_-]?string)$/i.test(key)
      ? '[REDACTED]' : redactFields(item)]));
}

const line = (record: BusFollowRecord): string => JSON.stringify(sanitizePublicJson(redactFields(record)));

/** Delivery is accepted only when the write callback settles, so a checkpoint
 * is never emitted ahead of messages still buffered by the output stream. */
function stdoutLine(text: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const fail = (error: Error): void => { reject(error); };
    process.stdout.once('error', fail);
    try {
      process.stdout.write(text + '\n', error => {
        if (error) reject(error); else resolve();
        setImmediate(() => process.stdout.off('error', fail));
      });
    } catch (error) {
      process.stdout.off('error', fail);
      reject(error);
    }
  });
}

/** Convention-resolved CLI entry. Streams scrubbed JSONL message and checkpoint
 * records; never executes bodies and never writes to the store. */
export async function cmdFleetBusFollow(args: string[], deps: Dependencies = {}): Promise<number> {
  const say = async (text: string): Promise<boolean> => {
    try { await (deps.emit ?? ((value: string) => console.log(value)))(text); return true; } catch { return false; }
  };
  const invalid = async (): Promise<number> => { await say(JSON.stringify({ status: 'invalid' })); return 2; };
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nEmits {"type":"message",cursor,receivedAt,envelope} and {"type":"checkpoint","cursor":N} records, ` +
      'then a final checkpoint at the deadline. Local observation only; routing labels are not authenticated identities and bodies are never executed.');
    return 0;
  }
  const values: Record<string, string> = {};
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) { json = true; continue; }
    const match = /^(--after|--duration-ms|--to|--interval-ms|--root)(?:=(.*))?$/.exec(args[i]!);
    if (!match || Object.hasOwn(values, match[1]!)) return invalid();
    const value = match[2] ?? args[++i];
    if (value === undefined || value === '' || value.startsWith('--')) return invalid();
    values[match[1]!] = value;
  }
  const number = (key: string): number => {
    const value = values[key];
    return value !== undefined && /^\d+$/.test(value) ? Number(value) : NaN;
  };
  const request: BusFollowRequest = {
    after: number('--after'), durationMs: number('--duration-ms'),
    intervalMs: values['--interval-ms'] === undefined ? undefined : number('--interval-ms'),
    to: values['--to'], root: values['--root'],
  };
  if (!json || !validBusFollowRequest(request)) return invalid();
  const controller = new AbortController(), stop = (): void => controller.abort();
  deps.signal?.addEventListener('abort', stop, { once: true });
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    if (deps.signal?.aborted) stop();
    const emit = async (record: BusFollowRecord): Promise<void> => {
      const text = line(record);
      if (deps.emit) await deps.emit(text); else await stdoutLine(text);
    };
    const result = await followBusStream(request, {
      emit, list: deps.list, signal: controller.signal, now: deps.now, clock: deps.clock,
    });
    return result.status === 'expired' || result.status === 'cancelled' ? 0 : result.status === 'invalid' ? 2 : 1;
  } finally {
    deps.signal?.removeEventListener('abort', stop);
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
}
