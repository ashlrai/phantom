/**
 * `fleet_bus_status` MCP adapter: the unified agent-bus health probe —
 * `readUnifiedBusStatus`, the same read `phm agents bus status` serves.
 * Every other bus tool reports its own slice — `fleet_agent_inbox` the
 * addressed page, `fleet_agent_work` the per-agent digest, `fleet_bus_channel`
 * the room transcript, `fleet_work_feed` the job projection — and each keeps
 * its own honest degraded state, but none answers "is the bus itself
 * healthy" in one call. This probe names every dependency the bus verbs
 * touch: the message store, identity registry, wake queue, coordination
 * table, message-id claim journal, claim-drift verdict, work-feed
 * projection, legacy mailbox, owner-chat receipts ledger, shared task
 * board and fleet queue, bot-seat store, peer work-dispatch journal, peer
 * coordination ledger, the agentnet peer session bindings and dispatch
 * policy every `peers` verb authenticates and gates against, the pending
 * peer-mail backlog `peers read` would return for live-enrolled
 * callsigns, the transport dead-letter sink's retained
 * delivery-failure reports (pending count by recorded reason and
 * truncation — never envelope ids or bodies), the
 * session-handoff journal store behind
 * `phm checkpoint handoff list|show` and `fleet_session_handoffs`, and the
 * outbound send gate (`sendGate.state`
 * open/blocked/unknown with the kill-switch and comms-pause verdicts
 * kept separate) an agent can check before assuming a write would land.
 *
 * No arguments: every probe root — the bus store, runs dir, board and
 * queue overrides, seat home — stays server-owned, so unknown keys,
 * caller roots, paths and working directories are all refused before the
 * probe runs. Read-only: the probe takes no writer lock, writes nothing,
 * makes no network calls and grants nothing; each section reports its own
 * real state and a store that cannot be read reports `unavailable` with
 * null counts, never zero, and the probe never throws. Counts and verdicts
 * only — never labels, handles, claim keys, peer names, threads or bodies.
 */
import { readUnifiedBusStatus, type UnifiedBusStatus } from '../core/agents/bus-status.js';

/** The probe takes no caller input — every store root stays server-owned. */
export function parseFleetBusStatusArgs(args: Record<string, unknown>): Record<string, never> | null {
  return Object.keys(args).length === 0 ? {} : null;
}

export interface FleetBusStatusDeps {
  status?: typeof readUnifiedBusStatus;
}

interface FleetBusStatusMeta {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
}

/** The shared probe union with the MCP envelope metadata on every member. */
export type FleetBusStatusResult = FleetBusStatusMeta & UnifiedBusStatus;

/**
 * One health probe through the shared `readUnifiedBusStatus` read — the
 * identical probe `phm agents bus status` runs, so per-section states,
 * null-count honesty and the send-gate verdict can never diverge between
 * the CLI and this tool. The probe composes its own section reads and
 * never throws; `asOf` stays the probe's internally consistent read time
 * beside the envelope's `generatedAt`.
 */
export async function readFleetBusStatus(
  deps: FleetBusStatusDeps = {},
): Promise<FleetBusStatusResult> {
  const read = deps.status ?? readUnifiedBusStatus;
  const status = read();
  return {
    schemaVersion: 1 as const, snapshotKind: 'local-persisted' as const,
    authority: 'none' as const, generatedAt: new Date().toISOString(),
    ...status,
  };
}
