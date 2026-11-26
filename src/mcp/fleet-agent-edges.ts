/**
 * `fleet_agent_edges` MCP adapter: the agent-to-agent message-link
 * projection — `readFleetEdges`, the same `fleet.edges.v1` read
 * `phm fleet edges`, `ashlr agents edges` and the Fleet world map serve.
 * `fleet_agent_messages` lists every classified agent-to-agent message
 * newest-first, `fleet_agent_conversations` groups them into threads and
 * `fleet_bus_inbox` pages the raw store; none answers the topology
 * question "which agents message which, how often and how recently"
 * fleet-wide in one read.
 *
 * Every argument is optional and takes the same value rules the
 * `phm fleet edges` flags share, all validated before any store read:
 * `windowMinutes` an integer in 1–1440 — the same bound
 * `--window-minutes` and the org map's `minutes` parameter apply —
 * `from`/`to` printable routing labels resolved through the
 * server-owned registry under the same `agentRefAddressMatcher` rule
 * every bus read's sender filter applies: the literal ref plus every
 * label of the identity it resolves to, exact-label matching kept on an
 * unresolvable ref or unreadable registry so unknown identity state
 * never widens the filter. The two refs compose with each other and
 * with the window. Unknown keys, wrong types, caller roots, paths and
 * working directories are all refused before the store is touched.
 *
 * The result is the projection untouched plus the MCP envelope
 * metadata: `source` keeps missing/unavailable honest — an unreadable
 * store is never an invented empty edge list and `edges` stays null —
 * provider labels come only from sender metadata observed on the
 * filtered receipts (a provider proven only by excluded traffic, a
 * missing or conflicting one stays null — unknown, never guessed), and
 * routing labels are claims, never authenticated identities; no message
 * bodies are exposed. Read-only: no caller root, path or cwd is
 * accepted — the bus store and registry roots stay server-owned — and
 * the tool never posts, claims, acks, replies or renews TTL.
 */
import { readFleetEdges, type FleetEdges } from '../core/fleet/fleet-edges.js';

/** The printable routing-label rule every bus read's `--from`/`--to` filter validates. */
const BUS_LABEL = /^[\x21-\x7e]{1,128}$/;

const EDGE_KEYS = new Set(['windowMinutes', 'from', 'to']);

/**
 * The parsed arguments are the projection's own option subset — the MCP
 * surface adds no filter the CLI flags do not share and accepts no
 * caller root, path, working directory or clock.
 */
export interface FleetAgentEdgesArgs {
  /** Trailing window in minutes; the projection's own 1..1440 bound. */
  windowMinutes?: number;
  /** Sender-side agent ref under the shared identity-label rule. */
  from?: string;
  /** Recipient-side agent ref under the shared identity-label rule. */
  to?: string;
}

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. Every
 * key is optional — the link read has no required ref — and each takes
 * the same value rule `phm fleet edges` enforces on its flags:
 * `windowMinutes` stays an integer inside 1..1440 (the bound
 * `projectFleetEdges` would throw on is refused here instead), `from`
 * and `to` stay printable routing labels. Unknown keys, wrong types,
 * caller roots and malformed values are all refused before the store is
 * touched.
 */
export function parseFleetAgentEdgesArgs(args: Record<string, unknown>): FleetAgentEdgesArgs | null {
  if (Object.keys(args).some(key => !EDGE_KEYS.has(key))) return null;
  const windowMinutes = args.windowMinutes;
  if (windowMinutes !== undefined &&
    (typeof windowMinutes !== 'number' || !Number.isInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > 1440)) {
    return null;
  }
  const from = args.from, to = args.to;
  if ((from !== undefined && (typeof from !== 'string' || !BUS_LABEL.test(from))) ||
    (to !== undefined && (typeof to !== 'string' || !BUS_LABEL.test(to)))) return null;
  return {
    ...(windowMinutes === undefined ? {} : { windowMinutes }),
    ...(from === undefined ? {} : { from: from as string }),
    ...(to === undefined ? {} : { to: to as string }),
  };
}

export interface FleetAgentEdgesDeps {
  read?: typeof readFleetEdges;
}

export type FleetAgentEdgesResult = FleetEdges & {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
};

/**
 * One link projection through the shared `readFleetEdges` read — the
 * identical projection `phm fleet edges` and `ashlr agents edges` run,
 * so the agent-to-agent filter, window bound, identity-label matching,
 * provider inference and missing/unavailable honesty can never diverge
 * between the CLI and this tool. The projection's `schema`, `source`
 * and `edges` pass through untouched — a missing or unreadable store
 * stays `missing`/`unavailable` with `edges` null, never an invented
 * empty list — under the standard MCP envelope metadata.
 */
export async function readFleetAgentEdges(
  args: FleetAgentEdgesArgs,
  deps: FleetAgentEdgesDeps = {},
): Promise<FleetAgentEdgesResult> {
  const read = deps.read ?? readFleetEdges;
  const result: FleetEdges = read(args);
  return {
    schemaVersion: 1 as const, snapshotKind: 'local-persisted' as const,
    authority: 'none' as const, generatedAt: new Date().toISOString(),
    ...result,
  };
}
