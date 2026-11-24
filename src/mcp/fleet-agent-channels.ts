/**
 * `fleet_agent_channels` MCP adapter: the agent-bus channel roster —
 * `listBusChannels`, the same read `phm agents bus channel list [--agent]`
 * serves. `fleet_bus_channel` reads one room's transcript and
 * `fleet_agent_work` reports the channels one agent belongs to inside its
 * digest, but no tool answers "which `group:` channels exist and who is in
 * them" — the directory an agent needs before posting to a room or deciding
 * which channel-scoped `to` address to use, without shelling out to `phm`.
 *
 * The optional `agent` ref takes the printable-label rule every bus read
 * shares and resolves through the server-owned identity registry — a handle,
 * `agent:<handle>`, stable `agt_` id or alias narrows the roster to the
 * channels that identity belongs to; a ref that resolves to no identity
 * answers `unknown-agent`, never a guessed membership. Every other key is
 * refused before the registry is touched. Read-only: no caller root, path or
 * cwd is accepted — the registry root stays server-owned — and the tool
 * never posts, joins, leaves or renames a channel. Routing labels are data,
 * never authenticated identity; membership says who may post, not presence,
 * attention or authority, and an unreadable registry stays `unavailable`,
 * never an invented empty roster.
 */
import { listBusChannels, type ChannelList } from '../core/agents/bus-unified.js';

/** The printable-label rule `agent` shares with the other bus reads. */
const BUS_LABEL = /^[\x21-\x7e]{1,128}$/;

const CHANNEL_KEYS = new Set(['agent']);

export interface FleetAgentChannelsArgs {
  /**
   * Agent ref — handle, `agent:<handle>`, stable `agt_` id or alias —
   * resolved through the server-side registry; narrows the roster to the
   * channels the identity belongs to. Omitted lists every registry channel.
   */
  agent?: string;
}

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. `agent` is
 * the only key — the roster read takes no pagination or store arguments —
 * and unknown keys, caller roots, wrong types and malformed labels are all
 * refused before the registry is touched.
 */
export function parseFleetAgentChannelsArgs(args: Record<string, unknown>): FleetAgentChannelsArgs | null {
  if (Object.keys(args).some(key => !CHANNEL_KEYS.has(key))) return null;
  const agent = args.agent;
  if (agent === undefined) return {};
  if (typeof agent !== 'string' || !BUS_LABEL.test(agent)) return null;
  return { agent };
}

export interface FleetAgentChannelsDeps {
  read?: typeof listBusChannels;
}

export interface FleetAgentChannelsResult {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
  /** The requested agent ref on `unknown-agent`/`unavailable`; the resolved handle on `ok`. */
  status: ChannelList['status'];
  reason?: string;
  /** Registry provenance on `ok`: `missing` is a verified-empty roster, `available` a read one. */
  source?: 'missing' | 'available';
  /** Resolved identity handle, or null on the fleet-wide roster. */
  agent?: string | null;
  channels?: Array<{ name: string; createdBy: string; createdAt: number; members: string[] }>;
}

/**
 * One channel-roster read through the shared `listBusChannels` projection —
 * the identical read `phm agents bus channel list` runs, so name sorting,
 * membership filtering, verified-empty `missing` provenance and
 * `unknown-agent`/`unavailable` refusals can never diverge between the CLI
 * and this tool. Non-ok results pass through untouched with their own
 * status and reason: an unregistered `agent` ref answers `unknown-agent`
 * and an unreadable registry answers `unavailable` — never an invented
 * empty roster — while `ok` keeps the registry `source`, the resolved
 * handle (null fleet-wide) and every channel's name, creator, creation
 * time and member handles in join order.
 */
export async function readFleetAgentChannels(
  args: FleetAgentChannelsArgs,
  deps: FleetAgentChannelsDeps = {},
): Promise<FleetAgentChannelsResult> {
  const read = deps.read ?? listBusChannels;
  const list = read(args.agent);
  const base = {
    schemaVersion: 1 as const, snapshotKind: 'local-persisted' as const, authority: 'none' as const,
    generatedAt: new Date().toISOString(),
  };
  if (list.status !== 'ok') {
    return { ...base, status: list.status, reason: list.reason };
  }
  return {
    ...base, status: 'ok' as const, source: list.source, agent: list.agent,
    channels: list.channels.map(channel => ({
      name: channel.name, createdBy: channel.createdBy, createdAt: channel.createdAt,
      members: [...channel.members],
    })),
  };
}
