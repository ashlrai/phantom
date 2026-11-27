/**
 * `phm fleet bus-hops` reads the newest validated cross-agent bus hops —
 * recorded send attempts, never bodies — under the same filters
 * `fleet_bus_hops` applies. Read-only: the private hop log's bounded tail
 * with from/to/exclude-from/id/channel/topic narrowing and honest
 * missing/unreadable states; the CLI twin of the MCP read, no writes.
 */
import { validateBusEnvelope } from '../core/fleet/bus-envelope.js';
import { agentChannelNameSchema } from '../core/agents/bus-identity.js';
import { BUS_HOPS_MAX_LIMIT, readBusHops } from '../core/fleet/bus-hops.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: phm fleet bus-hops [--limit <1..50>] [--from <ref>] [--to <ref>] [--exclude-from <ref>] [--id <id>] [--channel <name>] [--topic <topic>] [--json]\n'
  + 'Read the newest validated cross-agent bus hops — recorded send attempts with message id, from/to and nullable token usage, never bodies or delivery claims.\n'
  + 'The same read fleet_bus_hops serves over MCP; the hop log carries no timestamps, so position in append order is the only ordering it proves.\n'
  + 'A hop is only a recorded send attempt: it carries message id, from/to and nullable token usage, never a body, delivery, or lifecycle\n'
  + 'claim. Missing and unreadable are distinct; neither yields invented rows. Usage totals are subtotals of the returned tail\'s\n'
  + 'recorded attempts, not provider usage or proof of delivery; unknown samples remain separate.\n'
  + 'The read scans the bounded tail window once, then applies the optional from/to/excludeFrom/id/channel/topic filters and returns\n'
  + 'the newest limit matches oldest-first. matched counts the filter hits inside that scanned window — a lower bound when truncated\n'
  + 'reports rows beyond it, never a fleet-wide total the bounded read cannot prove. --from/--to/--exclude-from resolve a handle,\n'
  + 'agent:<handle>, stable id or alias through the identity registry under the same label-matching rule every bus read applies; an\n'
  + 'unresolvable ref or unreadable registry keeps exact-label matching, so unknown identity state never widens the read. --channel\n'
  + 'keeps only hops addressed to group:<channel>:* — the room\'s whole traffic under every topic — and --topic keeps only hops addressed\n'
  + 'to a well-formed group:<room>:<topic> label carrying that exact topic component; both decide on the hop\'s own to label with no\n'
  + 'registry dependence. Read-only: writes nothing and never executes a body; routing labels are data, never authenticated identity.';

/** The value flags the read accepts; each takes exactly one value. */
const VALUE_FLAGS = new Set(['--limit', '--from', '--to', '--exclude-from', '--id', '--channel', '--topic']);
/** Routing labels use the bus wire contract: printable ASCII tokens of 1..128 characters — the same check fleet_bus_hops' argument parser applies. */
function hopsAddressLabel(value: string): boolean {
  return validateBusEnvelope({ id: value, from: value, to: value, priority: 'P3', ttl: 1, body: null }).ok;
}

const safe = (value: unknown): string => JSON.stringify(sanitizePublicJson(value)).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

export async function cmdFleetBusHops(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  const invalid = (): number => { console.log(JSON.stringify({ status: 'invalid' })); return 2; };
  let json = false, limit: number | undefined;
  const raw = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) { json = true; continue; }
    const equal = arg.indexOf('=');
    const flag = equal > 0 ? arg.slice(0, equal) : arg;
    if (!VALUE_FLAGS.has(flag) || raw.has(flag)) return invalid();
    const value = equal > 0 ? arg.slice(equal + 1) : args[++i];
    if (value === undefined || value === '' || (equal < 0 && value.startsWith('--'))) return invalid();
    raw.set(flag, value);
  }
  const limitRaw = raw.get('--limit');
  if (limitRaw !== undefined) {
    if (!/^\d+$/.test(limitRaw)) return invalid();
    limit = Number(limitRaw);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > BUS_HOPS_MAX_LIMIT) return invalid();
  }
  for (const flag of ['--from', '--to', '--exclude-from', '--id'] as const) {
    const value = raw.get(flag);
    if (value !== undefined && !hopsAddressLabel(value)) return invalid();
  }
  for (const flag of ['--channel', '--topic'] as const) {
    const value = raw.get(flag);
    if (value !== undefined && !agentChannelNameSchema.safeParse(value).success) return invalid();
  }
  const result = readBusHops({
    ...(limit === undefined ? {} : { limit }),
    ...(raw.get('--from') === undefined ? {} : { from: raw.get('--from')! }),
    ...(raw.get('--to') === undefined ? {} : { to: raw.get('--to')! }),
    ...(raw.get('--exclude-from') === undefined ? {} : { excludeFrom: raw.get('--exclude-from')! }),
    ...(raw.get('--id') === undefined ? {} : { id: raw.get('--id')! }),
    ...(raw.get('--channel') === undefined ? {} : { channel: raw.get('--channel')! }),
    ...(raw.get('--topic') === undefined ? {} : { topic: raw.get('--topic')! }),
  });
  if (json) { console.log(JSON.stringify(sanitizePublicJson(result))); return result.sourceState === 'unreadable' ? 1 : 0; }
  if (result.hops === null) {
    console.log(result.sourceState === 'missing' ? 'No bus hop log — no hops recorded.' : 'Bus hop log unreadable.');
    return result.sourceState === 'unreadable' ? 1 : 0;
  }
  for (const hop of result.hops) {
    const tokens = (value: number | null): string => value === null ? 'unknown' : String(value);
    console.log(`${safe(hop.id)}  ${safe(hop.from)} → ${safe(hop.to)}  in=${tokens(hop.inputTokens)} out=${tokens(hop.outputTokens)}`);
  }
  console.log(`matched=${result.matched} returned=${result.returnedHops} skippedRows=${result.skippedRows} truncated=${result.truncated ? 'yes' : 'no'}`);
  return 0;
}
