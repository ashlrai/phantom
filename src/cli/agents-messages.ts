/** `phm agents messages`: thin argv adapter for core/fleet/agents-messages.ts. Exit 0 read, 1 bus unreadable, 2 bad usage. */
export const AGENTS_MESSAGES_USAGE = `Usage: phm agents messages [--since 1h] [--before <10m|2h|1d|ISO|epoch>] [--agent <name|lane>] [--with <name|lane>] [--kind <ask|reply|handoff|status|blocker>] [--priority <P0|P1|P2|P3>] [--job <id>] [--thread <label>] [--channel <name>] [--contains <text>] [--from <name|lane>] [--exclude-from <name|lane>] [--to <name|lane|label>] [--in-reply-to <id>] [--id <id>] [--body-kind <kind>] [--result <reserved|admitted|complete|failed>] [--limit N] [--json]

Recent agent-to-agent messages from the agent bus (default: the last hour,
newest 50): time, from, to, kind, a summary of at most 160 characters and the
thread when the message names one. Every filter is the same vocabulary
\`phm messages\` parses — --agent with --with keeps only what those two said to
each other; --kind keeps one classified kind; --priority keeps one envelope
band; --job keeps the traffic naming one job; --thread keeps note/context
bodies carrying that v2 thread label; --channel keeps posts addressed to
group:<name>:*; --contains keeps summaries carrying that text;
--from/--exclude-from keep or drop one sender's mail; --in-reply-to keeps
only envelopes citing that id and --id keeps only the envelope whose own
wire id equals it; --body-kind keeps only bodies carrying that exact kind
discriminator; --result keeps only work.result receipts whose own outcome
strictly equals reserved, admitted, complete or failed — the same outcome
vocabulary the work feed's --result filter validates — with the same
matching rules and identity
resolution \`phm messages --help\` describes. --before keeps only messages
received strictly before its cutoff, so --since and --before read one closed
[since, before) window. from and to are the node ids the map draws
(leader, lane:<name>, job:<id>); an agent the map does not draw is "unknown".
--json prints agents.messages.v1 (schema, version, messages[], pairs[] with the
message count and last 5 summaries per line, matched counting every message
the filters kept before --limit). Read only.`;

export async function runAgentsMessagesCli(args: string[], out: (text: string) => void = console.log,
  err: (text: string) => void = console.error): Promise<number> {
  if (args.some(arg => arg === '--help' || arg === '-h')) { out(AGENTS_MESSAGES_USAGE); return 0; }
  let json = false;
  const values: { since?: string; before?: string; limit?: string; agent?: string; with?: string; kind?: string;
    priority?: string; job?: string; thread?: string; channel?: string; contains?: string; from?: string;
    excludeFrom?: string; to?: string; inReplyTo?: string; id?: string; bodyKind?: string; result?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!, value = args[i + 1];
    if (arg === '--json' && !json) { json = true; continue; }
    const key = arg === '--since' ? 'since' : arg === '--before' ? 'before' : arg === '--agent' ? 'agent'
      : arg === '--with' ? 'with' : arg === '--kind' ? 'kind' : arg === '--priority' ? 'priority'
      : arg === '--job' ? 'job' : arg === '--thread' ? 'thread' : arg === '--channel' ? 'channel'
      : arg === '--contains' ? 'contains' : arg === '--from' ? 'from' : arg === '--exclude-from' ? 'excludeFrom'
      : arg === '--to' ? 'to' : arg === '--in-reply-to' ? 'inReplyTo' : arg === '--id' ? 'id' : arg === '--body-kind' ? 'bodyKind'
      : arg === '--result' ? 'result'
      : arg === '--limit' ? 'limit' : null;
    if (!key || values[key] !== undefined || value === undefined || value.startsWith('--')) { err(AGENTS_MESSAGES_USAGE); return 2; }
    values[key] = value; i++;
  }
  const { formatAgentsMessagesText, readAgentsMessages } = await import('../core/fleet/agents-messages.js');
  const read = readAgentsMessages(values);
  if (!read.ok) { err(read.error); return 2; }
  out(json ? JSON.stringify(read.result, null, 2) : formatAgentsMessagesText(read.result));
  return read.result.source === 'unavailable' ? 1 : 0;
}
