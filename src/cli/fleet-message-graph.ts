/** Recent agent messages as lines between organizations. Thin: core/fleet/message-graph.ts builds it. */
import { parseAgentMessagesQuery, parseSince } from '../core/fleet/agent-messages.js';
import { formatMessageGraphText, readMessageGraph } from '../core/fleet/message-graph.js';

const usage = `Usage: phm fleet message-graph [--json] [--since <10m|2h|1d|ISO>] [--before <10m|2h|1d|ISO|epoch>] [--agent <name|lane>] [--with <name|lane>] [--kind <ask|reply|handoff|status|blocker>] [--priority <P0|P1|P2|P3>] [--job <id>] [--thread <label>] [--channel <name>] [--topic <topic>] [--contains <text>] [--from <name|lane>] [--exclude-from <name|lane>] [--to <name|lane|label>] [--in-reply-to <id>] [--id <id>] [--body-kind <kind>] [--result <reserved|admitted|complete|failed>]

Recent agent messages as lines between organizations (default: the last 15
minutes). Each line lists the agents behind it with message counts and the
last message time. No message text is shown. Every filter is the same
vocabulary \`phm messages\` parses — the matching rules \`phm map edges
--help\` describes — so "which organizations talked about job X" or "which
lines carry P0 traffic" is one filtered read here too. --before keeps only
messages received strictly before its cutoff, so --since and --before read
one closed [since, before) window. Read only.
--json prints fleet.message-graph.v1, the same read as GET /api/fleet/message-graph.
Exit 0 read, 1 bus unreadable, 2 bad usage.`;

/** The `phm messages` filter flags this read forwards to the shared parser — dashed flag to query key, the same set `phm map edges` takes (no `--limit`: the graph aggregates the whole matched set and never paginates). */
const FILTER_FLAGS: Record<string, string> = {
  '--agent': 'agent', '--with': 'with', '--kind': 'kind', '--priority': 'priority',
  '--job': 'job', '--thread': 'thread', '--channel': 'channel', '--topic': 'topic', '--contains': 'contains',
  '--from': 'from', '--exclude-from': 'excludeFrom', '--to': 'to',
  '--in-reply-to': 'inReplyTo', '--id': 'id', '--body-kind': 'bodyKind', '--result': 'result',
};

export async function cmdFleetMessageGraph(args: string[]): Promise<number> {
  if (args.some(arg => arg === '--help' || arg === '-h')) { console.log(usage); return 0; }
  let json = false, since: string | undefined, before: string | undefined;
  const filters: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) { json = true; continue; }
    if (arg === '--since' && since === undefined && args[i + 1] !== undefined) { since = args[++i]; continue; }
    if (arg === '--before' && before === undefined && args[i + 1] !== undefined) {
      const value = args[++i]!;
      if (parseSince(value) === null) { console.error('--before takes 10m, 2h, 1d, epoch ms or an ISO time.'); return 2; }
      before = value; continue;
    }
    const key = FILTER_FLAGS[arg], value = args[i + 1];
    if (key === undefined || filters[key] !== undefined || value === undefined || value.startsWith('--')) {
      console.error(usage); return 2;
    }
    filters[key] = value; i++;
  }
  const parsed = parseAgentMessagesQuery(filters);
  if (!parsed.ok) { console.error(parsed.error); return 2; }
  const graph = readMessageGraph(since, { before, filters: parsed.query });
  if (!graph) { console.error('--since takes 10m, 2h, 1d, epoch ms or an ISO time.'); return 2; }
  console.log(json ? JSON.stringify(graph, null, 2) : formatMessageGraphText(graph));
  return graph.source === 'unavailable' ? 1 : 0;
}
