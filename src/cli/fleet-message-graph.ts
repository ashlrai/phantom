/** Recent agent messages as lines between organizations. Thin: core/fleet/message-graph.ts builds it. */
import { formatMessageGraphText, readMessageGraph } from '../core/fleet/message-graph.js';

const usage = `Usage: phm fleet message-graph [--json] [--since <10m|2h|1d|ISO>]

Recent agent messages as lines between organizations (default: the last 15
minutes). Each line lists the agents behind it with message counts and the
last message time. No message text is shown. Read only.
--json prints fleet.message-graph.v1, the same read as GET /api/fleet/message-graph.
Exit 0 read, 1 bus unreadable, 2 bad usage.`;

export async function cmdFleetMessageGraph(args: string[]): Promise<number> {
  if (args.some(arg => arg === '--help' || arg === '-h')) { console.log(usage); return 0; }
  let json = false, since: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--since' && since === undefined && args[i + 1] !== undefined) since = args[++i];
    else { console.error(usage); return 2; }
  }
  const graph = readMessageGraph(since);
  if (!graph) { console.error('--since takes 10m, 2h, 1d, epoch ms or an ISO time.'); return 2; }
  console.log(json ? JSON.stringify(graph, null, 2) : formatMessageGraphText(graph));
  return graph.source === 'unavailable' ? 1 : 0;
}
