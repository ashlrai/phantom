/**
 * `fleet_agent_identities` MCP adapter: the agent-bus identity roster —
 * `readAgentRegistry` joined with `seatParticipants`, the same read
 * `phm agents bus id list` serves. Every other bus read consumes a resolved
 * identity inside its own slice — `fleet_agent_identity` answers "what is
 * this one ref", `fleet_agent_channels` the channel roster, `fleet_agent_roster`
 * the live session roster and `fleet_bot_seats` the full seat view — but no
 * tool answers the directory question an agent asks before it addresses
 * anyone: "which identities are registered on this bus, under which handles,
 * aliases and runtimes, and which seat participants answer alongside them"
 * without shelling out to `phm`.
 *
 * Takes no arguments — every store root stays server-owned and any argument
 * is refused — because the shared fleet server has no per-caller scope the
 * roster could narrow to. `identities` reports each registered identity's
 * stable `agt_` id, handle, display name, aliases, runtimes and creation
 * time; `channels` the registry channel names, creators, creation times and
 * member handles; `participants` the bot-seat participant projection
 * `id list` joins (participantId, provider, displayName, capabilities, wake,
 * status — the routing labels seats answer under, where `fleet_bot_seats`
 * carries the richer per-seat quota and claim view). `source` keeps registry
 * provenance honest: `missing` is a verified-empty registry while an
 * unreadable one stays `unavailable`, never an invented empty roster. A
 * throwing seat-participant read reports `unavailable` with its own reason —
 * the same honesty `fleet_bot_seats` applies — never an empty participant
 * list passed off as fact.
 *
 * Read-only: no caller root, path or cwd is accepted, and the tool never
 * registers, aliases, joins channels or writes. An identity is a routing
 * name and the labels it answers to — never authentication, presence or
 * authority.
 */
import { readAgentRegistry, type AgentChannel, type AgentIdentity } from '../core/agents/bus-identity.js';
import { seatParticipants } from '../core/bots/seats.js';
import type { Participant } from '../core/agents/bus-v2-schema.js';

/** The roster takes no arguments — every store root stays server-owned. */
export type FleetAgentIdentitiesArgs = Record<string, never>;

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. Any key —
 * caller roots, filters, limits — is refused before either store is read.
 */
export function parseFleetAgentIdentitiesArgs(args: Record<string, unknown>): FleetAgentIdentitiesArgs | null {
  return Object.keys(args).length === 0 ? {} : null;
}

export interface FleetAgentIdentitiesDeps {
  registry?: typeof readAgentRegistry;
  participants?: typeof seatParticipants;
}

export interface FleetAgentIdentitiesResult {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
  /** `ok` on a complete read; `unavailable` when the registry or the seat-participant read cannot be verified — never an invented roster. */
  status?: 'ok' | 'unavailable';
  reason?: string;
  /** Registry provenance on ok: `missing` is a verified-empty registry, `available` a read store. */
  source?: 'missing' | 'available';
  /** Registered identities in registry order — id, handle, displayName, aliases, runtimes, createdAt. */
  identities?: AgentIdentity[];
  /** Registry channels in registry order — name, members, createdBy, createdAt. */
  channels?: AgentChannel[];
  /** Bot-seat participant projection in seat order — participantId, provider, displayName, capabilities, wake, status. */
  participants?: Participant[];
}

/**
 * One roster read through the shared `readAgentRegistry` + `seatParticipants`
 * join `phm agents bus id list` runs, so registry parsing, invariant checks,
 * the verified-empty `missing` verdict and the seat participant projection
 * can never diverge between the CLI and this tool. An unreadable registry
 * answers `unavailable` with its own reason — the same verdict the CLI
 * read reports — and a throwing seat-participant read answers `unavailable`
 * rather than an empty participant list passed off as fact. Every returned
 * record is deep-copied so the result cannot alias the stores. Routing
 * labels are data, never authenticated identity.
 */
export async function readFleetAgentIdentities(
  deps: FleetAgentIdentitiesDeps = {},
): Promise<FleetAgentIdentitiesResult> {
  const base = {
    schemaVersion: 1 as const, snapshotKind: 'local-persisted' as const, authority: 'none' as const,
    generatedAt: new Date().toISOString(),
  };
  const read = (deps.registry ?? readAgentRegistry)();
  if (read.status !== 'ok') {
    return { ...base, status: 'unavailable', reason: read.reason };
  }
  let participants: Participant[];
  try {
    participants = await (deps.participants ?? seatParticipants)();
  } catch {
    return { ...base, status: 'unavailable', reason: 'Bot seat participant roster is unreadable.' };
  }
  return {
    ...base, status: 'ok', source: read.source,
    identities: read.registry.identities.map(identity => structuredClone(identity)),
    channels: read.registry.channels.map(channel => structuredClone(channel)),
    participants: participants.map(participant => structuredClone(participant)),
  };
}
