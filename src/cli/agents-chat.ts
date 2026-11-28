import { sanitizePublicJson } from '../core/util/public-json.js';
import { formatAgentChatText, readAgentChat, type ChatQuery, type ChatResult } from '../core/agents/chat.js';
import { frameAgentChat, getBusCliAdapter, type BusCliAdapter } from '../core/agents/bus-cli-adapters.js';
import { BUS_PRIORITIES, type BusPriority } from '../core/fleet/bus-envelope.js';
import { parseSince } from '../core/fleet/agent-messages.js';
const HELP = 'phm agents chat list|read <outcome:id|run:id> --channel <channel> [--topic <topic>] [--after <cursor>] [--limit <1-100>] [--from <agent>] [--exclude-from <agent>] [--contains <text>] [--since <15m|2h|1d|ISO>] [--before <15m|2h|1d|ISO>] [--id <id>] [--in-reply-to <id>] [--priority <P0|P1|P2|P3>] [--frame <cli>] [--json]';
export function runAgentsChat(args: string[], out = console.log, err = console.error,
  read: (query: ChatQuery) => ChatResult = readAgentChat): number {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { out(HELP); return 0; }
  const [verb, ...rest] = args;
  const query: ChatQuery = { channel: '' };
  if (verb === 'read') query.thread = rest.shift();
  const seen = new Set<string>();
  let invalid = verb !== 'list' && verb !== 'read';
  let json = false, frame: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (seen.has(arg)) { invalid = true; break; }
    seen.add(arg);
    if (arg === '--json') { json = true; continue; }
    const value = rest[++i];
    if (!value) { invalid = true; break; }
    if (arg === '--channel') query.channel = value;
    else if (arg === '--topic') query.topic = value;
    else if (arg === '--from') query.from = value;
    else if (arg === '--exclude-from') query.excludeFrom = value;
    else if (arg === '--contains') query.contains = value;
    else if (arg === '--id') query.id = value;
    else if (arg === '--in-reply-to') query.inReplyTo = value;
    else if (arg === '--priority') {
      if (!(BUS_PRIORITIES as readonly string[]).includes(value)) { invalid = true; break; }
      query.priority = value as BusPriority;
    }
    else if (arg === '--since' || arg === '--before') {
      const ms = parseSince(value);
      if (ms === null) { invalid = true; break; }
      if (arg === '--since') query.since = ms; else query.before = ms;
    } else if (arg === '--frame' && !value.startsWith('--')) frame = value;
    else if ((arg === '--after' || arg === '--limit') && /^\d+$/.test(value)) {
      query[arg === '--after' ? 'after' : 'limit'] = Number(value);
    } else invalid = true;
  }
  if (invalid || !query.channel || (verb === 'read' && !query.thread)) { err(HELP); return 2; }
  let adapter: BusCliAdapter | undefined;
  if (frame !== undefined) {
    adapter = getBusCliAdapter(frame);
    if (adapter === undefined) { err(HELP); return 2; }
  }
  const result = read(query);
  if (adapter !== undefined) {
    const framed = frameAgentChat(adapter.cli, formatAgentChatText(result).split('\n'));
    out(json ? JSON.stringify(sanitizePublicJson({ ...result, framed }), null, 2) : framed);
  } else {
    out(JSON.stringify(sanitizePublicJson(result)));
  }
  return result.status === 'ok' ? 0 : result.status === 'invalid' ? 2 : 1;
}
