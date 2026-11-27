/**
 * `fleet_agent_mesh` MCP adapter: the flat agent mesh — `readAgentMesh`,
 * the same read-only `agent-mesh.v1` projection `phm agents mesh status
 * [--json]` serves. Every other `fleet_agent_*` read answers a question
 * about one slice of the bus — addressed mail (`fleet_agent_inbox`), the
 * pending-work digest (`fleet_agent_work`), wake hints
 * (`fleet_agent_wakes`), the classified timeline (`fleet_agent_messages`),
 * the channel roster (`fleet_agent_channels`), one identity card
 * (`fleet_agent_identity`), the identity directory
 * (`fleet_agent_identities`), the grouped threads
 * (`fleet_agent_conversations`), the message-link topology
 * (`fleet_agent_edges`) and the live probed session roster
 * (`fleet_agent_roster`) — but none answers the bus-native observation
 * question an agent asks before it addresses or waits on anyone: "which
 * registered identities are observable right now, under which direct
 * `agent:<handle>` address, lane, last-seen, current task and status" —
 * without shelling out to `phm`.
 *
 * Takes no arguments: every store root and clock stays server-owned, so
 * unknown keys, caller roots, paths and working directories are refused
 * before any store is touched — the shared fleet server has no per-caller
 * PHM_AGENT_ID or `--root` the read could narrow to. On `ok` the result is
 * the projection's own `agent-mesh.v1` view plus MCP metadata: `asOf` the
 * read clock and `agents` every registered identity joined to its freshest
 * retained `fleet.mesh` observation — `address`, `lane`, `lastSeen`,
 * `currentTask`, `status` and whether the row came from a `registry`
 * runtime or a bus `desktop`/`cli`/`imessage` observation. Unknown
 * providers and unobserved timestamps stay `null` and stale observations
 * report `unknown`/`offline`; a missing registry is an honest empty
 * `agents` list — no identities are registered to observe — while an
 * unreadable registry or bus store reports its own status, never an
 * invented mesh.
 *
 * Read-only: the read joins the identity registry and retained bus
 * receipts only — no probes, no network calls, no writes — and the tool
 * never publishes observations, registers identities or mutates claims.
 * Routing labels and observations are data, never authenticated identity,
 * presence proof or execution authority; no caller root, path or cwd is
 * accepted.
 */
import { readAgentMesh, type MeshAgent } from '../core/agents/mesh.js';

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. The mesh
 * read takes no caller input — every store root stays server-owned — so
 * only an empty argument object passes; unknown keys, caller roots, paths
 * and working directories are all refused before any store is touched.
 */
export function parseFleetAgentMeshArgs(args: Record<string, unknown>): Record<string, never> | null {
  return Object.keys(args).length === 0 ? {} : null;
}

export interface FleetAgentMeshDeps {
  mesh?: typeof readAgentMesh;
}

interface FleetAgentMeshMeta {
  schemaVersion: 1;
  /** Joined from the persisted identity registry and retained bus receipts — not a live probe. */
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
}

/** The shared mesh union with the MCP envelope metadata on every member. */
export type FleetAgentMeshResult = FleetAgentMeshMeta & ReturnType<typeof readAgentMesh>;

/**
 * One fleet-wide mesh read through the shared `readAgentMesh` projection —
 * the identical read `phm agents mesh status` runs, so registry joining,
 * observation freshness, expiry and every status verdict can never diverge
 * between the CLI and this tool. Non-ok results pass through untouched
 * with their own status and empty `agents` list: an unreadable registry or
 * bus store is never an invented mesh — while `ok` keeps the projection's
 * `agent-mesh.v1` schema tag, `asOf` clock and every agent row's address,
 * lane, last-seen, current task, status and observation source. A throwing
 * read reports `unavailable` with an empty list — the same honesty the
 * per-store failure statuses apply — never an invented roster.
 */
export async function readFleetAgentMesh(
  deps: FleetAgentMeshDeps = {},
): Promise<FleetAgentMeshResult> {
  const mesh = deps.mesh ?? readAgentMesh;
  const meta: FleetAgentMeshMeta = {
    schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
    generatedAt: new Date().toISOString(),
  };
  try {
    return { ...meta, ...mesh() };
  } catch {
    return { ...meta, status: 'unavailable' as const, agents: [] as MeshAgent[] };
  }
}
