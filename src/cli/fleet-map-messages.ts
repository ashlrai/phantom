/** `phm fleet map messages`: the last agent-to-agent messages. Thin: core/fleet/map-messages.ts reads them. */
import { frameAgentMessages, getBusCliAdapter } from '../core/agents/bus-cli-adapters.js';
import { formatMapMessagesText, MAP_MESSAGES_MAX_LIMIT, readMapMessages,
  type MapMessagesFlags, type MapMessagesOptions } from '../core/fleet/map-messages.js';

export const MAP_MESSAGES_USAGE = `Usage: phm fleet map messages [--json] [--since <10m|2h|1d|ISO|epoch>] [--before <10m|2h|1d|ISO|epoch>] [--agent <name|lane>] [--with <name|lane>] [--kind <ask|reply|handoff|status|blocker>] [--priority <P0|P1|P2|P3>] [--job <id>] [--thread <label>] [--channel <name>] [--topic <topic>] [--contains <text>] [--from <name|lane>] [--exclude-from <name|lane>] [--to <name|lane|label>] [--in-reply-to <id>] [--id <id>] [--body-kind <kind>] [--result <reserved|admitted|complete|failed>] [--limit <1-${MAP_MESSAGES_MAX_LIMIT}>] [--frame <cli>]

The last agent-to-agent messages (default: the last 15 minutes, newest 20),
one line each: who to whom, what kind, and a short redacted summary. Never the
raw envelope. Every filter is the same vocabulary \`phm messages\` parses —
--agent with --with keeps only what those two said to each other; --kind keeps
one classified kind; --priority keeps one envelope band; --job keeps the
traffic naming one job; --thread keeps note/context bodies carrying that v2
thread label; --channel keeps posts addressed to group:<name>:*; --topic
keeps posts addressed to a well-formed group:<room>:<topic> address
carrying that topic, composing with --channel into one room and one topic;
--contains
keeps summaries carrying that text; --from/--exclude-from keep or drop one
sender's mail; --in-reply-to keeps only envelopes citing that id, --id
keeps only the envelope whose own wire id equals it and --body-kind keeps
only bodies carrying that exact kind discriminator; --result keeps only
work.result receipts whose own outcome strictly equals reserved, admitted,
complete or failed — the same outcome vocabulary the work feed's --result
filter validates — with the same matching
rules and identity resolution \`phm messages --help\` describes. --before
keeps only messages received strictly before its cutoff, so --since and
--before read one closed [since, before) window. The map can also open
scrubbed display text. --frame <cli> prints the same read as one bounded
block marked untrusted under BEGIN/END UNTRUSTED AGENT BUS TIMELINE markers —
the same frame \`phm messages --frame\` produces — with --json carrying it
as framed beside the full fleet.map-messages.v1 projection and the cut
stated when the 32 KiB bound clips the page. Read only.
--json prints fleet.map-messages.v1, the same read as GET /api/fleet/map/messages.
Exit 0 read, 1 bus unreadable, 2 bad usage.`;

const FLAG_KEYS: Record<string, keyof MapMessagesFlags> = {
  '--since': 'since', '--before': 'before', '--agent': 'agent', '--with': 'with',
  '--kind': 'kind', '--priority': 'priority', '--job': 'job', '--thread': 'thread',
  '--channel': 'channel', '--topic': 'topic', '--contains': 'contains', '--from': 'from',
  '--exclude-from': 'excludeFrom', '--to': 'to', '--in-reply-to': 'inReplyTo', '--id': 'id',
  '--body-kind': 'bodyKind', '--result': 'result', '--limit': 'limit',
};

export function cmdFleetMapMessages(args: string[], rowsOnly = false, options: MapMessagesOptions = {}): number {
  const usage = rowsOnly ? MAP_MESSAGES_USAGE.replaceAll('fleet map messages', 'fleet messages')
    .replace('--json prints fleet.map-messages.v1,', '--json prints message rows from') : MAP_MESSAGES_USAGE;
  if (args.some(arg => arg === '--help' || arg === '-h')) { console.log(usage); return 0; }
  let json = false, frame: string | undefined;
  const values: MapMessagesFlags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!, value = args[i + 1];
    if (arg === '--json' && !json) { json = true; continue; }
    if (arg === '--frame' && frame === undefined && value !== undefined && !value.startsWith('--')) { frame = value; i++; continue; }
    const key = FLAG_KEYS[arg];
    if (!key || values[key] !== undefined || value === undefined || value.startsWith('--')) {
      console.error(usage); return 2;
    }
    values[key] = value; i++;
  }
  const adapter = frame === undefined ? undefined : getBusCliAdapter(frame);
  if (frame !== undefined && adapter === undefined) { console.error(usage); return 2; }
  const read = readMapMessages(values, options);
  if (!read.ok) { console.error(read.error); return 2; }
  const result = read.result;
  if (adapter !== undefined) {
    const framed = frameAgentMessages(adapter.cli, formatMapMessagesText(result).split('\n'));
    console.log(json ? JSON.stringify({ ...result, framed }, null, 2) : framed);
  } else {
    console.log(json ? JSON.stringify(rowsOnly
      ? result.messages?.map(({ from, to, kind, at, summary }) => ({ from, to, kind, at, summary })) ?? null
      : result, null, 2) : formatMapMessagesText(result));
  }
  return result.source === 'unavailable' ? 1 : 0;
}
