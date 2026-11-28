import { isAbsolute } from 'node:path';
import { parseFleetEdgesQuery, readFleetEdges, type FleetEdgesQueryInput } from '../core/fleet/fleet-edges.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: phm fleet edges [--window-minutes <1..1440>] [--from <agent>] [--to <agent>] [--channel <name>] [--topic <topic>] [--since <15m|2h|1d|ISO>] [--before <15m|2h|1d|ISO>] [--priority <P0|P1|P2|P3>] [--kind <ask|reply|handoff|status|blocker>] [--job <id>] [--contains <text>] [--root <absolute>] [--json]\nRead live agent bus message links.';

/** The value-taking filter flags, each mapped to the shared query key it feeds. */
const VALUE_FLAGS: Record<string, keyof FleetEdgesQueryInput> = {
  '--window-minutes': 'windowMinutes', '--from': 'from', '--to': 'to',
  '--channel': 'channel', '--topic': 'topic', '--since': 'since',
  '--before': 'before', '--priority': 'priority', '--kind': 'kind',
  '--job': 'job', '--contains': 'contains',
};

export async function cmdFleetEdges(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let json = false, root: string | undefined;
  const query: FleetEdgesQueryInput = {};
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') { if (json) return 2; json = true; continue; }
    if (arg === '--root') {
      if (root !== undefined) return 2;
      const value = args[++i];
      if (value === undefined || !isAbsolute(value) || value.includes('\u0000')) return 2;
      root = value;
      continue;
    }
    // `--flag=value` also parses, so a value that itself starts with `--`
    // (a `--contains` needle like `--force`) stays expressible; the bare
    // `--flag value` form still refuses a value that looks like another flag.
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const key = VALUE_FLAGS[flag];
    if (key === undefined || seen.has(flag)) return 2;
    seen.add(flag);
    const value = eq === -1 ? args[++i] : arg.slice(eq + 1);
    if (value === undefined || value === '' || (eq === -1 && value.startsWith('--'))) return 2;
    query[key] = value;
  }
  const parsed = parseFleetEdgesQuery(query);
  if (!parsed.ok) return 2;
  const result = readFleetEdges({ ...parsed.options, ...(root === undefined ? {} : { root }) });
  console.log(json ? JSON.stringify(sanitizePublicJson(result)) : result.edges === null ? 'Agent message links unknown.' : result.edges.map(edge => `${String(sanitizePublicJson(edge.from.address))} → ${String(sanitizePublicJson(edge.to.address))}: ${edge.messages}`).join('\n') || 'No live agent messages.');
  return result.source === 'unavailable' ? 1 : 0;
}
