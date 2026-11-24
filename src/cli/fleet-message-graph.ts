/** Recent agent messages as lines between organizations. Thin: core/fleet/message-graph.ts builds it. */
import { formatMessageGraphText, readMessageGraph } from '../core/fleet/message-graph.js';
import type { MapEdgesFlags } from '../core/fleet/map-edges.js';

const usage = `Usage: phm fleet message-graph [--json] [--since <10m|2h|1d|ISO|epoch>] [--before <10m|2h|1d|ISO|epoch>] [--agent <name|lane>] [--with <name|lane>] [--kind <ask|reply|handoff|status|blocker>] [--priority <P0|P1|P2|P3>] [--job <id>] [--thread <label>] [--channel <name>] [--contains <text>] [--from <name|lane>] [--exclude-from <name|lane>] [--in-reply-to <id>] [--id <id>]

Recent agent messages as lines between organizations (default: the last 15
minutes). Each line lists the agents behind it with message counts and the
last message time. No message text is shown. Every filter is the same
vocabulary \`phm messages\` parses — the matching rules \`phm map edges
--help\` describes — so "which organizations talked about job X" is one
filtered read here too. --before keeps only messages received strictly before
its cutoff, so --since and --before read one closed [since, before) window.
Read only.
--json prints fleet.message-graph.v1, the same read as GET /api/fleet/message-graph.
Exit 0 read, 1 bus unreadable, 2 bad usage.`;

const FLAG_KEYS: Record<string, keyof MapEdgesFlags> = {
  '--since': 'since', '--before': 'before', '--agent': 'agent', '--with': 'with',
  '--kind': 'kind', '--priority': 'priority', '--job': 'job', '--thread': 'thread',
  '--channel': 'channel', '--contains': 'contains', '--from': 'from',
  '--exclude-from': 'excludeFrom', '--in-reply-to': 'inReplyTo', '--id': 'id',
};

export async function cmdFleetMessageGraph(args: string[]): Promise<number> {
  if (args.some(arg => arg === '--help' || arg === '-h')) { console.log(usage); return 0; }
  let json = false;
  const values: MapEdgesFlags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!, value = args[i + 1];
    if (arg === '--json' && !json) { json = true; continue; }
    const key = FLAG_KEYS[arg];
    if (!key || values[key] !== undefined || value === undefined || value.startsWith('--')) {
      console.error(usage); return 2;
    }
    values[key] = value; i++;
  }
  const graph = readMessageGraph(values);
  if (!graph.ok) { console.error(graph.error); return 2; }
  const result = graph.result;
  console.log(json ? JSON.stringify(result, null, 2) : formatMessageGraphText(result));
  return result.source === 'unavailable' ? 1 : 0;
}
