import { listBusInboxAfter } from '../core/fleet/bus-inbox.js';
import { parseSince } from '../core/fleet/agent-messages.js';
import { followBusStream, validBusFollowRequest, type BusFollowRecord, type BusFollowRequest } from '../core/fleet/bus-follow-stream.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: ashlr fleet bus-follow --after <nonnegative-safe-cursor> --duration-ms <1..3600000> [--id <id>] [--in-reply-to <id>] [--to <agent-or-topic>] [--channel <name>] [--job <id>] [--from <agent-or-label>] [--exclude-from <agent-or-label>] [--priority P0..P3] [--kind <task|result|review|status|question>] [--topic <name|ns.*>] [--body-kind <kind>] [--thread <t>] [--since <15m|2h|1d|ISO>] [--before <15m|2h|1d|ISO>] [--contains <text>] [--interval-ms <100..60000>] [--root <absolute>] --json';

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
      'then a final checkpoint at the deadline. --to matches mail addressed to one registered agent identity under ' +
      'every routing label or to a channel it belongs to, minus its own channel posts — the same pending-work rule ' +
      'bus next claims by; an unresolvable --to or unreadable registry keeps exact-label matching. ' +
      '--job keeps only envelopes naming that job — the same citation rule agents bus inbox --job applies. ' +
      '--channel keeps only envelopes addressed to group:<name>:* — the room\'s whole traffic under every ' +
      'topic, the same raw address prefix phm messages --channel, agents bus wakes --channel, ' +
      'channel read and the work feed\'s --channel match (the addressed agents bus inbox --channel ' +
      'resolves the same prefix only across channels the agent belongs to), decided on the to label ' +
      'with no registry dependence. ' +
      '--from keeps only envelopes sent by that agent or label under every registered spelling of its identity; ' +
      '--exclude-from drops envelopes sent under every registered spelling of one identity, the same ' +
      'sender-exclusion rule comms bus read --exclude-from and fleet_bus_inbox apply; ' +
      '--priority, --thread and --since narrow on the same envelope fields agents bus inbox filters by; ' +
      '--before keeps only rows received strictly before the cutoff — the exclusive upper bound ' +
      'that composes with --since into one [since, before) window, the same receivedAt < before ' +
      'match comms bus read|watch --before and fleet_bus_inbox\'s before apply; ' +
      '--id and --in-reply-to keep only the exact envelope id or bodies replying to it, and --kind and ' +
      '--topic narrow on the protocol-v1 body fields — the same filters comms bus read|watch and ' +
      'fleet_bus_inbox apply to this store; ' +
      '--body-kind keeps only envelopes whose body carries that exact kind discriminator — the v2 kind ' +
      'field, a protocol-v1 protocol.kind or a type/schema notice key, matched exactly like the ' +
      'agents bus inbox --body-kind and phm messages --body-kind reads apply, so a body carrying no ' +
      'discriminator never matches; ' +
      '--contains keeps only envelopes whose scrubbed one-line summary carries the needle — the same ' +
      'case-insensitive text search agents bus inbox --contains and comms bus read --contains apply. ' +
      'Local observation only; routing labels are not authenticated identities and bodies are never executed.');
    return 0;
  }
  const values: Record<string, string> = {};
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) { json = true; continue; }
    const match = /^(--after|--duration-ms|--id|--in-reply-to|--to|--channel|--job|--from|--exclude-from|--priority|--kind|--topic|--body-kind|--thread|--since|--before|--contains|--interval-ms|--root)(?:=(.*))?$/.exec(args[i]!);
    if (!match || Object.hasOwn(values, match[1]!)) return invalid();
    const value = match[2] ?? args[++i];
    if (value === undefined || value === '' || value.startsWith('--')) return invalid();
    values[match[1]!] = value;
  }
  const number = (key: string): number => {
    const value = values[key];
    return value !== undefined && /^\d+$/.test(value) ? Number(value) : NaN;
  };
  const sinceRaw = values['--since'];
  const since = sinceRaw === undefined ? undefined : parseSince(sinceRaw);
  if (sinceRaw !== undefined && since === null) return invalid();
  const beforeRaw = values['--before'];
  const before = beforeRaw === undefined ? undefined : parseSince(beforeRaw);
  if (beforeRaw !== undefined && before === null) return invalid();
  const request: BusFollowRequest = {
    after: number('--after'), durationMs: number('--duration-ms'),
    intervalMs: values['--interval-ms'] === undefined ? undefined : number('--interval-ms'),
    to: values['--to'], channel: values['--channel'], job: values['--job'], from: values['--from'], excludeFrom: values['--exclude-from'],
    priority: values['--priority'] as BusFollowRequest['priority'],
    kind: values['--kind'] as BusFollowRequest['kind'], topic: values['--topic'], bodyKind: values['--body-kind'],
    thread: values['--thread'], since: since ?? undefined, before: before ?? undefined, contains: values['--contains'],
    id: values['--id'], inReplyTo: values['--in-reply-to'], root: values['--root'],
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
