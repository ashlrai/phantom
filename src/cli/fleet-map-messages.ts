/** `phm fleet map messages`: the last agent-to-agent messages. Thin: core/fleet/map-messages.ts reads them. */
import { parseSince } from '../core/fleet/agent-messages.js';
import { formatMapMessagesText, MAP_MESSAGES_MAX_LIMIT, parseMapMessagesLimit, readMapMessages } from '../core/fleet/map-messages.js';

export const mapMessagesUsage = `Usage: phm fleet map messages [--json] [--since <10m|2h|1d|ISO>] [--before <10m|2h|1d|ISO|epoch>] [--limit <1-${MAP_MESSAGES_MAX_LIMIT}>]

The last agent-to-agent messages (default: the last 15 minutes, newest 20),
one line each: who to whom, what kind, and a short redacted summary. Never the
raw envelope. --before keeps only messages received strictly before its cutoff,
so --since and --before read one closed [since, before) window. The map can
also open scrubbed display text. Read only.
--json prints fleet.map-messages.v1, the same read as GET /api/fleet/map/messages.
Exit 0 read, 1 bus unreadable, 2 bad usage.`;

export function cmdFleetMapMessages(args: string[], rowsOnly = false): number {
  const usage = rowsOnly ? mapMessagesUsage.replaceAll("fleet map messages", "fleet messages").replace("--json prints fleet.map-messages.v1,", "--json prints message rows from") : mapMessagesUsage;
  if (args.some(arg => arg === '--help' || arg === '-h')) { console.log(usage); return 0; }
  let json = false, since: string | undefined, before: string | undefined, limit: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--since' && since === undefined && args[i + 1] !== undefined) since = args[++i];
    else if (args[i] === '--before' && before === undefined && args[i + 1] !== undefined) {
      const value = args[++i]!;
      if (parseSince(value) === null) { console.error('--before takes 10m, 2h, 1d, epoch ms or an ISO time.'); return 2; }
      before = value;
    } else if (args[i] === '--limit' && limit === undefined && args[i + 1] !== undefined) {
      const parsed = parseMapMessagesLimit(args[++i]!);
      if (parsed === null) { console.error(`--limit takes a whole number from 1 to ${MAP_MESSAGES_MAX_LIMIT}.`); return 2; }
      limit = parsed;
    } else { console.error(usage); return 2; }
  }
  const read = readMapMessages(since, { limit, before });
  if (!read) { console.error('--since takes 10m, 2h, 1d, epoch ms or an ISO time.'); return 2; }
  console.log(json ? JSON.stringify(rowsOnly ? read.messages?.map(({ from, to, kind, at, summary }) => ({ from, to, kind, at, summary })) ?? null : read, null, 2) : formatMapMessagesText(read));
  return read.source === 'unavailable' ? 1 : 0;
}
