/** `phm messages`: thin argv layer over core/fleet/agent-messages.ts. */
export const MESSAGES_USAGE = `Usage: phm messages [--since <15m|2h|1d|ISO>] [--agent <name|lane>] [--with <name|lane>] [--kind <ask|reply|handoff|status|blocker>] [--priority <P0|P1|P2|P3>] [--job <id>] [--thread <label>] [--channel <name>] [--contains <text>] [--from <name|lane>] [--exclude-from <name|lane>] [--in-reply-to <id>] [--limit <n>] [--text]
Agent-to-agent messages on the local agent bus, newest first: id, ts, priority,
from, to, kind (ask, reply, handoff, status, blocker), a one-line scrubbed
summary, and the related job or PR when known. --agent with --with shows only
what those two said to each other; --kind keeps only one classified kind;
--priority keeps only one envelope band; --job keeps only the messages that
name one job — its job link, a live jobState citation or the job:<id>
conversation — so one job's whole bus traffic is a single filtered read;
--thread keeps only note/context bodies carrying that v2 thread label, the
same match agents bus inbox --thread and comms bus read --thread apply;
--channel keeps only the posts addressed to group:<name>:* — the room's
whole traffic under every topic, the same address prefix agents bus inbox
--channel and channel read match — so one room's classified traffic is a
single filtered read while agent mail and other rooms stay out;
--contains keeps only the messages whose scrubbed summary carries that text
(case-insensitive substring), the fleet-wide text search no other bus read
offers; --from keeps only the messages one sender wrote — a handle, alias
or agent: address of one registered identity matches every label of that
identity, an unresolvable ref keeps exact name/lane matching, deciding on
each row's from only so rows merely addressed to that agent stay out — the
same sender-inclusion rule comms bus read|watch --from, agents bus inbox
--from, agents bus channel read --from, agents bus wakes --from, fleet
bus-follow --from and fleet_agent_inbox's from apply, so "what did agent X
send" is one filtered read of the whole fleet timeline; --exclude-from drops
the messages one sender wrote — a handle, alias
or agent: address of one registered identity drops every label of that
identity, an unresolvable ref keeps exact name/lane matching — the same
sender-exclusion rule comms bus read|watch --exclude-from, fleet bus-follow
--exclude-from, fleet_bus_inbox's excludeFrom and agents bus inbox/channel
read's excludeFrom apply, deciding on each row's from only so rows merely
addressed to that agent still list; --in-reply-to keeps only the envelopes
whose object body cites that envelope id through its own inReplyTo field —
the same own-property exact match comms bus read|watch --in-reply-to,
fleet bus-follow --in-reply-to and fleet_bus_inbox's inReplyTo apply, never
the replyTo alias or a substring — so "who answered envelope X" is one
filtered read of the whole fleet timeline, replies addressed to anyone;
JSON by default; --text for
people. Read-only.
Damaged bus records are skipped and counted. Exit 0 read, 1 bus unreadable, 2 bad usage.`;

export async function cmdMessages(args: string[]): Promise<number> {
  if (args.some(a => a === '--help' || a === '-h' || a === 'help')) { console.log(MESSAGES_USAGE); return 0; }
  let text = false;
  const values: { since?: string; agent?: string; with?: string; kind?: string; priority?: string; job?: string; thread?: string; contains?: string; from?: string; excludeFrom?: string; inReplyTo?: string; channel?: string; limit?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--text') { text = true; continue; }
    if (arg === '--json') continue;
    const key = arg === '--since' ? 'since' : arg === '--agent' ? 'agent' : arg === '--with' ? 'with'
      : arg === '--kind' ? 'kind' : arg === '--priority' ? 'priority' : arg === '--job' ? 'job'
      : arg === '--thread' ? 'thread' : arg === '--channel' ? 'channel' : arg === '--contains' ? 'contains'
      : arg === '--from' ? 'from' : arg === '--exclude-from' ? 'excludeFrom' : arg === '--in-reply-to' ? 'inReplyTo'
      : arg === '--limit' ? 'limit' : null;
    const value = args[i + 1];
    if (!key || values[key] !== undefined || value === undefined || value.startsWith('--')) { console.error(MESSAGES_USAGE); return 2; }
    values[key] = value; i++;
  }
  const core = await import('../core/fleet/agent-messages.js');
  const parsed = core.parseAgentMessagesQuery(values);
  if (!parsed.ok) { console.error(text ? parsed.error : JSON.stringify({ error: parsed.error })); return 2; }
  const result = core.readAgentMessages(parsed.query);
  console.log(text ? core.formatAgentMessagesText(result) : JSON.stringify(result, null, 2));
  return result.source === 'unavailable' ? 1 : 0;
}
