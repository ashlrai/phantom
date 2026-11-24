/**
 * `fleet_agent_roster` MCP adapter: the unified live session roster —
 * `collectAgentRoster`, the same read-only `agent-roster.v1` projection
 * `phm agents roster` and the native `phm_agent_roster` tool serve. Every
 * other `fleet_agent_*` read answers a question about the bus itself —
 * addressed mail (`fleet_agent_inbox`), the pending-work digest
 * (`fleet_agent_work`), wake hints (`fleet_agent_wakes`), the classified
 * timeline (`fleet_agent_messages`), the channel roster
 * (`fleet_agent_channels`), one identity card (`fleet_agent_identity`) and
 * the grouped threads (`fleet_agent_conversations`) — and `fleet_bus_status`
 * reports the bus stores' health, but none answers the presence question an
 * agent asks before it routes, hands off or waits: "which agent sessions are
 * actually running right now, on which provider, and what is each holding."
 *
 * The roster probes nine sources in parallel — Phantom's own live workers,
 * Devin cloud, the Devin Desktop/CLI roster file, Codex, Claude, Cursor,
 * Grok, Ollama and oMLX — each bounded by a short timeout, then joins the
 * live coordination leases every session's claims come from. A probe that
 * times out, is missing or returns an unrecognized shape degrades only its
 * own source to `unknown` with its reason — never an invented empty or
 * populated list — and the per-source `ok`/`availability`/`error` fields keep
 * that honesty visible. Session titles, ownership, urls and blockers are
 * scrubbed of secrets and control characters inside the projection, and the
 * fleet server scrubs every string again at serialization; fencing tokens
 * never leave the claim store.
 *
 * Optional principal/allOwners selectors use the four-field reduced view.
 * Every probe target, store root and clock stays server-owned. No caller path
 * is accepted; selectors grant no read, send, claim or execution authority.
 */
import { collectAgentRoster, parseRosterViewOptions, selectAgentRoster, validateAgentRoster,
  type AgentRoster, type RosterViewOptions } from '../core/fleet/agent-roster.js';

/** Selectors only; every probe target and store root stays server-owned. */
export const parseFleetAgentRosterArgs = parseRosterViewOptions;

/** Projection happens after the server-owned reader, including injected readers. */
export function selectFleetAgentRoster(value: unknown, options: RosterViewOptions): unknown {
  if (!options.allOwners && !options.principal) return value;
  if (validateAgentRoster(value)) throw new Error('Agent roster unavailable');
  return selectAgentRoster(value as AgentRoster, options);
}

export interface FleetAgentRosterDeps {
  roster?: () => Promise<AgentRoster>;
}

interface FleetAgentRosterMeta {
  schemaVersion: 1;
  /** Probed live across providers at call time — not a persisted snapshot or a single remote API. */
  snapshotKind: 'live-observation';
  authority: 'none';
  generatedAt: string;
}

/** The shared roster union with the MCP envelope metadata on every member. */
export type FleetAgentRosterResult = FleetAgentRosterMeta & (
  | AgentRoster
  | { status: 'unavailable'; reason: 'agent-roster-unreadable' }
);

/**
 * One fleet-wide live session roster through the shared `collectAgentRoster`
 * projection — the identical read `phm agents roster` runs, so per-source
 * availability, session fields, claim joins and latency can never diverge
 * between the CLI and this tool. A throwing roster read reports
 * `unavailable` with its own reason — the same honesty the per-source
 * `unknown` degradation applies — never an empty roster passed off as fact.
 */
export async function readFleetAgentRoster(
  deps: FleetAgentRosterDeps = {},
): Promise<FleetAgentRosterResult> {
  const roster = deps.roster ?? (() => collectAgentRoster());
  const meta: FleetAgentRosterMeta = {
    schemaVersion: 1, snapshotKind: 'live-observation', authority: 'none',
    generatedAt: new Date().toISOString(),
  };
  try {
    return { ...meta, ...(await roster()) };
  } catch {
    return { ...meta, status: 'unavailable' as const, reason: 'agent-roster-unreadable' as const };
  }
}
