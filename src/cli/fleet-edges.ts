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

/**
 * Parse the value-taking filter flags out of an argv tail — `--flag value`
 * and `--flag=value` forms, each flag at most once, a bare `--flag` value
 * never starting with `--` so a value that looks like another flag stays
 * expressible only through the `=` form. Shared by `phm fleet edges` and
 * `ashlr agents edges` so the two reads can never disagree about which flags
 * exist or how a value parses; `--json` and `--root` are each dispatcher's
 * own concern and stay out of this list.
 */
export function parseFleetEdgesValueArgs(args: readonly string[]): { ok: true; query: FleetEdgesQueryInput } | { ok: false } {
  const query: FleetEdgesQueryInput = {};
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const key = VALUE_FLAGS[flag];
    if (key === undefined || seen.has(flag)) return { ok: false };
    seen.add(flag);
    const value = eq === -1 ? args[++i] : arg.slice(eq + 1);
    if (value === undefined || value === '' || (eq === -1 && value.startsWith('--'))) return { ok: false };
    query[key] = value;
  }
  return { ok: true, query };
}

export async function cmdFleetEdges(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let json = false, root: string | undefined;
  const valueArgs: string[] = [];
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
    valueArgs.push(arg);
  }
  const valueParsed = parseFleetEdgesValueArgs(valueArgs);
  if (!valueParsed.ok) return 2;
  const parsed = parseFleetEdgesQuery(valueParsed.query);
  if (!parsed.ok) return 2;
  const result = readFleetEdges({ ...parsed.options, ...(root === undefined ? {} : { root }) });
  console.log(json ? JSON.stringify(sanitizePublicJson(result)) : result.edges === null ? 'Agent message links unknown.' : result.edges.map(edge => `${String(sanitizePublicJson(edge.from.address))} → ${String(sanitizePublicJson(edge.to.address))}: ${edge.messages}`).join('\n') || 'No live agent messages.');
  return result.source === 'unavailable' ? 1 : 0;
}
