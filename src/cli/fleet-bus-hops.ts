/**
 * `phm fleet bus-hops` reads the same bounded bus hop audit `fleet_bus_hops`
 * serves over MCP. Newest validated cross-agent send attempts (message id,
 * from/to, nullable token usage — never bodies, delivery or lifecycle
 * claims) from the private hop log, narrowed by the shared
 * from/to/exclude-from/id/channel/topic filters. Read-only; a missing log
 * and an unreadable one stay distinct, and unknown usage stays null, never
 * zero.
 */
import { isAbsolute } from 'node:path';
import { parseBusHopsArgs, readBusHops } from '../core/fleet/bus-hops.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: ashlr fleet bus-hops [--limit <1..50>] [--from <agent-or-label>] [--to <agent-or-label>] [--exclude-from <agent-or-label>] [--id <message-id>] [--channel <name>] [--topic <topic>] [--root <absolute>] [--json]\nNewest validated cross-agent bus hops from the private hop log — the same bounded read fleet_bus_hops serves; prints the JSON report, compact with --json.';

/** CLI flag → the BusHopsArgs field parseBusHopsArgs validates; --root stays a read option, never an arg. */
const FLAG_FIELDS = {
  '--limit': 'limit', '--from': 'from', '--to': 'to', '--exclude-from': 'excludeFrom',
  '--id': 'id', '--channel': 'channel', '--topic': 'topic',
} as const;

/** Convention-resolved CLI entry: argv in, the shared hop audit JSON out. */
export async function cmdFleetBusHops(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\n--from/--to/--exclude-from resolve a ref through the identity registry under every ` +
      'label that identity answers to, the same agentRefAddressMatcher rule fleet_bus_inbox applies; an ' +
      'unresolvable ref or unreadable registry keeps exact-label matching. --channel keeps hops addressed ' +
      'to group:<name>:* and --topic keeps one well-formed group topic, composing into one room AND one ' +
      'topic — decided on the to label with no registry dependence. The hop log carries no timestamps, so ' +
      'there is deliberately no --since/--before: append order is the only ordering the store proves. ' +
      'matched counts filter hits inside the bounded scanned window — a lower bound when truncated reports ' +
      'older rows, never a fleet-wide total. Local observation only; routing labels are not authenticated ' +
      'identities and a hop is a recorded send attempt, never proof of delivery.');
    return 0;
  }
  const invalid = (): number => { console.error(`Invalid arguments. ${usage}`); return 2; };
  let json = false, root: string | undefined;
  const raw: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const equal = arg.indexOf('=');
    const flag = equal > 0 ? arg.slice(0, equal) : arg;
    if (flag === '--json' && equal < 0 && !json) { json = true; continue; }
    if (flag === '--root' && root === undefined) {
      const value = equal > 0 ? arg.slice(equal + 1) : args[++i];
      if (value === undefined || value === '' || value.startsWith('--') || !isAbsolute(value) || value.includes('\0')) return invalid();
      root = value;
      continue;
    }
    const field = (FLAG_FIELDS as Record<string, string>)[flag];
    if (field === undefined || Object.hasOwn(raw, field)) return invalid();
    const value = equal > 0 ? arg.slice(equal + 1) : args[++i];
    if (value === undefined || value === '' || value.startsWith('--')) return invalid();
    raw[field] = value;
  }
  // parseBusHopsArgs is the one validator the MCP tool and this CLI share:
  // limit arrives as a number only when it is plainly digits, so a malformed
  // value reaches the shared check as a string and is refused the same way.
  const argsRecord: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(raw)) {
    argsRecord[field] = field === 'limit' && /^\d+$/.test(value) ? Number(value) : value;
  }
  const parsed = parseBusHopsArgs(argsRecord);
  if (parsed === null) return invalid();
  const result = readBusHops(parsed, root === undefined ? {} : { root });
  console.log(JSON.stringify(sanitizePublicJson(result), null, json ? undefined : 2));
  return result.sourceState === 'unreadable' ? 1 : 0;
}
