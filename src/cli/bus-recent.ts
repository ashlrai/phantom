/** `phm bus recent`: thin argv adapter for core/fleet/bus-recent.ts. Exit 0 read, 1 bus unreadable, 2 bad usage. */
export const BUS_RECENT_USAGE = `Usage: phm bus recent [--since 5m] [--before <10m|2h|1d|ISO|epoch>] [--agent <name|lane>] [--with <name|lane>] [--kind <ask|reply|handoff|status|blocker>] [--priority <P0|P1|P2|P3>] [--job <id>] [--thread <label>] [--channel <name>] [--contains <text>] [--from <name|lane>] [--exclude-from <name|lane>] [--in-reply-to <id>] [--id <id>] [--body-kind <kind>] [--json]

Agent-to-agent messages from the last 5 minutes (or --since 10m, 2h, 1d), newest
first: time, from, to, kind and a plain summary of at most 100 characters.
Every filter is the same vocabulary \`phm messages\` parses — the matching rules
\`phm messages --help\` describes — so "what did agents say about job X" or "what
did agent Y send" is one filtered read here too. --before keeps only messages
received strictly before its cutoff, so --since and --before read one closed
[since, before) window. No message text beyond that summary is shown. --json
prints bus.recent.v1 {schema, as_of, messages:[{at, from, to, kind, summary}]};
messages is null when the bus could not be read. Read only.`;

export async function cmdBusRecent(args: string[], out: (text: string) => void = console.log,
  err: (text: string) => void = console.error): Promise<number> {
  if (args.some(arg => arg === '--help' || arg === '-h')) { out(BUS_RECENT_USAGE); return 0; }
  let json = false;
  const values: { since?: string; before?: string; agent?: string; with?: string; kind?: string; priority?: string;
    job?: string; thread?: string; channel?: string; contains?: string; from?: string; excludeFrom?: string; inReplyTo?: string; id?: string; bodyKind?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!, value = args[i + 1];
    if (arg === '--json' && !json) { json = true; continue; }
    const key = arg === '--since' ? 'since' : arg === '--before' ? 'before' : arg === '--agent' ? 'agent'
      : arg === '--with' ? 'with' : arg === '--kind' ? 'kind' : arg === '--priority' ? 'priority'
      : arg === '--job' ? 'job' : arg === '--thread' ? 'thread' : arg === '--channel' ? 'channel'
      : arg === '--contains' ? 'contains' : arg === '--from' ? 'from' : arg === '--exclude-from' ? 'excludeFrom'
      : arg === '--in-reply-to' ? 'inReplyTo' : arg === '--id' ? 'id' : arg === '--body-kind' ? 'bodyKind' : null;
    if (!key || values[key] !== undefined || value === undefined || value.startsWith('--')) { err(BUS_RECENT_USAGE); return 2; }
    values[key] = value; i++;
  }
  const { formatBusRecentText, readBusRecent } = await import('../core/fleet/bus-recent.js');
  const read = readBusRecent(values);
  if (!read.ok) { err(read.error); return 2; }
  out(json ? JSON.stringify(read.result, null, 2) : formatBusRecentText(read.result));
  return read.result.messages === null ? 1 : 0;
}
