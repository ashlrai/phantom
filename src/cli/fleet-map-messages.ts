/** `phm fleet map messages`: the last agent-to-agent messages. Thin: core/fleet/map-messages.ts reads them. */
import { formatMapMessagesText, MAP_MESSAGES_MAX_LIMIT, readMapMessages,
  type MapMessagesFlags } from '../core/fleet/map-messages.js';

export const MAP_MESSAGES_USAGE = `Usage: phm fleet map messages [--json] [--since <10m|2h|1d|ISO|epoch>] [--before <10m|2h|1d|ISO|epoch>] [--agent <name|lane>] [--with <name|lane>] [--kind <ask|reply|handoff|status|blocker>] [--priority <P0|P1|P2|P3>] [--job <id>] [--thread <label>] [--channel <name>] [--contains <text>] [--from <name|lane>] [--exclude-from <name|lane>] [--to <name|lane|label>] [--in-reply-to <id>] [--id <id>] [--body-kind <kind>] [--limit <1-${MAP_MESSAGES_MAX_LIMIT}>]

The last agent-to-agent messages (default: the last 15 minutes, newest 20),
one line each: who to whom, what kind, and a short redacted summary. Never the
raw envelope. Every filter is the same vocabulary \`phm messages\` parses —
--agent with --with keeps only what those two said to each other; --kind keeps
one classified kind; --priority keeps one envelope band; --job keeps the
traffic naming one job; --thread keeps note/context bodies carrying that v2
thread label; --channel keeps posts addressed to group:<name>:*; --contains
keeps summaries carrying that text; --from/--exclude-from keep or drop one
sender's mail; --in-reply-to keeps only envelopes citing that id, --id
keeps only the envelope whose own wire id equals it and --body-kind keeps
only bodies carrying that exact kind discriminator — with the same matching
rules and identity resolution \`phm messages --help\` describes. --before
keeps only messages received strictly before its cutoff, so --since and
--before read one closed [since, before) window. The map can also open
scrubbed display text. Read only.
--json prints fleet.map-messages.v1, the same read as GET /api/fleet/map/messages.
Exit 0 read, 1 bus unreadable, 2 bad usage.`;

const FLAG_KEYS: Record<string, keyof MapMessagesFlags> = {
  '--since': 'since', '--before': 'before', '--agent': 'agent', '--with': 'with',
  '--kind': 'kind', '--priority': 'priority', '--job': 'job', '--thread': 'thread',
  '--channel': 'channel', '--contains': 'contains', '--from': 'from',
  '--exclude-from': 'excludeFrom', '--to': 'to', '--in-reply-to': 'inReplyTo', '--id': 'id',
  '--body-kind': 'bodyKind', '--limit': 'limit',
};

export function cmdFleetMapMessages(args: string[], rowsOnly = false): number {
  const usage = rowsOnly ? MAP_MESSAGES_USAGE.replaceAll('fleet map messages', 'fleet messages')
    .replace('--json prints fleet.map-messages.v1,', '--json prints message rows from') : MAP_MESSAGES_USAGE;
  if (args.some(arg => arg === '--help' || arg === '-h')) { console.log(usage); return 0; }
  let json = false;
  const values: MapMessagesFlags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!, value = args[i + 1];
    if (arg === '--json' && !json) { json = true; continue; }
    const key = FLAG_KEYS[arg];
    if (!key || values[key] !== undefined || value === undefined || value.startsWith('--')) {
      console.error(usage); return 2;
    }
    values[key] = value; i++;
  }
  const read = readMapMessages(values);
  if (!read.ok) { console.error(read.error); return 2; }
  const result = read.result;
  console.log(json ? JSON.stringify(rowsOnly
    ? result.messages?.map(({ from, to, kind, at, summary }) => ({ from, to, kind, at, summary })) ?? null
    : result, null, 2) : formatMapMessagesText(result));
  return result.source === 'unavailable' ? 1 : 0;
}
