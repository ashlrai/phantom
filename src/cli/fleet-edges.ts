import { isAbsolute } from 'node:path';
import { readFleetEdges } from '../core/fleet/fleet-edges.js';
import { mapWindowMinutesOrNull } from '../core/fleet/org-map.js';
import { agentChannelNameSchema } from '../core/agents/bus-identity.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: phm fleet edges [--window-minutes <1..1440>] [--from <agent>] [--to <agent>] [--channel <name>] [--topic <topic>] [--root <absolute>] [--json]\nRead live agent bus message links.';

/** Same printable routing-label bound every bus read's --from/--to filter validates. */
const EDGE_REF = /^[\x21-\x7e]{1,128}(?![\s\S])/;

export async function cmdFleetEdges(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let json = false, windowMinutes: number | undefined, root: string | undefined;
  let from: string | undefined, to: string | undefined, channel: string | undefined, topic: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) { json = true; continue; }
    if (arg === '--window-minutes' && windowMinutes === undefined) {
      const value = args[++i];
      const minutes = value === undefined ? null : mapWindowMinutesOrNull(value);
      if (minutes === null) return 2;
      windowMinutes = minutes;
      continue;
    }
    if ((arg === '--from' || arg === '--to') && (arg === '--from' ? from : to) === undefined) {
      const value = args[++i];
      if (value === undefined || value.startsWith('--') || !EDGE_REF.test(value)) return 2;
      if (arg === '--from') from = value; else to = value;
      continue;
    }
    // --channel/--topic take the strict channel-name grammar every other bus
    // read's room filters enforce, so a value that cannot name a room or a
    // topic is a usage error here, never a silent empty page.
    if ((arg === '--channel' || arg === '--topic') && (arg === '--channel' ? channel : topic) === undefined) {
      const value = args[++i];
      if (value === undefined || value.startsWith('--') || !agentChannelNameSchema.safeParse(value).success) return 2;
      if (arg === '--channel') channel = value; else topic = value;
      continue;
    }
    if (arg === '--root' && root === undefined) {
      const value = args[++i];
      if (value === undefined || !isAbsolute(value) || value.includes('\u0000')) return 2;
      root = value;
      continue;
    }
    return 2;
  }
  const result = readFleetEdges({ ...(root === undefined ? {} : { root }),
    ...(windowMinutes === undefined ? {} : { windowMinutes }),
    ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }),
    ...(channel === undefined ? {} : { channel }), ...(topic === undefined ? {} : { topic }) });
  console.log(json ? JSON.stringify(sanitizePublicJson(result)) : result.edges === null ? 'Agent message links unknown.' : result.edges.map(edge => `${String(sanitizePublicJson(edge.from.address))} → ${String(sanitizePublicJson(edge.to.address))}: ${edge.messages}`).join('\n') || 'No live agent messages.');
  return result.source === 'unavailable' ? 1 : 0;
}
