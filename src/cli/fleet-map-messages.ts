/** `phm fleet map messages`: the last agent-to-agent messages. Thin: core/fleet/map-messages.ts reads them. */
import { formatMapMessagesText, MAP_MESSAGES_MAX_LIMIT, parseMapMessagesLimit, readMapMessages } from '../core/fleet/map-messages.js';

export const mapMessagesUsage = `Usage: phm fleet map messages [--json] [--since <10m|2h|1d|ISO>] [--limit <1-${MAP_MESSAGES_MAX_LIMIT}>]

The last agent-to-agent messages (default: the last 15 minutes, newest 20),
one line each: who to whom, what kind, and a short redacted summary. Never the
message body. Read only.
--json prints fleet.map-messages.v1, the same read as GET /api/fleet/map/messages.
Exit 0 read, 1 bus unreadable, 2 bad usage.`;

export function cmdFleetMapMessages(args: string[]): number {
  if (args.some(arg => arg === '--help' || arg === '-h')) { console.log(mapMessagesUsage); return 0; }
  let json = false, since: string | undefined, limit: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--since' && since === undefined && args[i + 1] !== undefined) since = args[++i];
    else if (args[i] === '--limit' && limit === undefined && args[i + 1] !== undefined) {
      const parsed = parseMapMessagesLimit(args[++i]!);
      if (parsed === null) { console.error(`--limit takes a whole number from 1 to ${MAP_MESSAGES_MAX_LIMIT}.`); return 2; }
      limit = parsed;
    } else { console.error(mapMessagesUsage); return 2; }
  }
  const read = readMapMessages(since, { limit });
  if (!read) { console.error('--since takes 10m, 2h, 1d, epoch ms or an ISO time.'); return 2; }
  console.log(json ? JSON.stringify(read, null, 2) : formatMapMessagesText(read));
  return read.source === 'unavailable' ? 1 : 0;
}
