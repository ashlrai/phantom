import { validateBusEnvelope, type BusPriority } from '../core/fleet/bus-envelope.js';
import { type BusInboxOptions, listBusInboxAfter } from '../core/fleet/bus-inbox.js';
import { parseSince } from '../core/fleet/agent-messages.js';
import { readBusThread, validBusThreadFilters, type BusThreadFilters } from '../core/fleet/bus-thread-context.js';
import type { WorkResultOutcome } from '../core/agents/bus-v2-schema.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: ashlr fleet bus-thread --id <id> [--json] [--to <ref>] [--from <ref>] [--exclude-from <ref>] ' +
  '[--channel <name>] [--job <id>] [--priority P0..P3] [--thread <t>] [--in-reply-to <id>] [--body-kind <kind>] ' +
  '[--result <reserved|admitted|complete|failed>] [--since <15m|2h|1d|ISO>] [--before <15m|2h|1d|ISO>] [--contains <text>]';
interface Dependencies {
  list?: typeof listBusInboxAfter;
  output?: (text: string) => void;
  error?: (text: string) => void;
}

/** The value flags the shared bus-read filter set adds beside --id/--json; each takes exactly one value. */
const FILTER_VALUE_FLAGS = new Set(['--to', '--from', '--exclude-from', '--channel', '--job', '--priority',
  '--thread', '--in-reply-to', '--body-kind', '--result', '--since', '--before', '--contains']);
/** The string-valued filters and the BusThreadFilters field each flag fills. */
const STRING_FILTERS = { '--to': 'to', '--from': 'from', '--exclude-from': 'excludeFrom', '--channel': 'channel',
  '--job': 'job', '--thread': 'thread', '--in-reply-to': 'inReplyTo', '--body-kind': 'bodyKind',
  '--contains': 'contains' } as const;

export async function cmdFleetBusThread(args: string[], options: BusInboxOptions = {}, deps: Dependencies = {}): Promise<number> {
  const output = deps.output ?? (text => console.log(text));
  const error = deps.error ?? (text => console.error(text));
  const invalid = (): number => { error(`Invalid arguments. ${usage}`); return 2; };
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    output(`${usage}\nReads retained live local context only; --json rows carry the same held/holder/job/fromAgent live evidence the unified bus reads annotate. The filter flags are the shared bus-read set — they narrow the projected chain members, never the inReplyTo walk, so rootFound/complete still describe the whole chain. Routing labels are not authenticated identities.`);
    return 0;
  }
  let id: string | undefined, json = false;
  const raw = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) json = true;
    else if ((arg === '--id' || arg.startsWith('--id=')) && id === undefined) {
      id = arg === '--id' ? args[++i] : arg.slice(5);
      if (!id || (arg === '--id' && id.startsWith('--'))) return invalid();
    } else {
      const equal = arg.indexOf('=');
      const flag = equal > 0 ? arg.slice(0, equal) : arg;
      if (!FILTER_VALUE_FLAGS.has(flag) || raw.has(flag)) return invalid();
      const value = equal > 0 ? arg.slice(equal + 1) : args[++i];
      if (value === undefined || (equal < 0 && value.startsWith('--'))) return invalid();
      raw.set(flag, value);
    }
  }
  if (!id || !validateBusEnvelope({ id, from: 'x', to: 'x', priority: 'P3', ttl: 1, body: null }).ok) return invalid();
  const filters: BusThreadFilters = {};
  for (const [flag, key] of Object.entries(STRING_FILTERS)) {
    const value = raw.get(flag);
    if (value !== undefined) filters[key] = value;
  }
  const priority = raw.get('--priority');
  if (priority !== undefined) filters.priority = priority as BusPriority;
  const outcome = raw.get('--result');
  if (outcome !== undefined) filters.result = outcome as WorkResultOutcome;
  for (const [flag, key] of [['--since', 'since'], ['--before', 'before']] as const) {
    const value = raw.get(flag);
    if (value === undefined) continue;
    const ms = parseSince(value);
    if (ms === null) return invalid();
    filters[key] = ms;
  }
  if (!validBusThreadFilters(filters)) return invalid();
  const result = readBusThread(id, { ...options, liveEvidence: true, filters }, deps.list);
  if (json) output(JSON.stringify(result));
  else {
    const safe = (value: unknown): string => JSON.stringify(sanitizePublicJson(value)).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    output(`Bus thread ${safe(id)}: ${result.complete ? result.rootFound ? `${result.messages.length} messages` : 'not found' : 'incomplete (source failure)'}; scanned through ${result.scannedThrough}.`);
    for (const row of result.messages) output(`${row.cursor} ${safe(row.envelope)}`);
  }
  return result.complete && result.rootFound ? 0 : 1;
}
