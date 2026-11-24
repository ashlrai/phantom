/**
 * `fleet_seat_handoffs` MCP adapter: the fleet-wide bot-seat handoff plan —
 * `planSeatHandoffs`, the same read-only projection `phm bots handoffs`,
 * the unified inbox's `seats` source and `phm agents bus work mine`'s
 * `seats` section share, so the CLI, the inbox item and the per-agent
 * digest can never disagree about which seats need draining and what work
 * would move. `fleet_agent_work` narrows the same plan to the seats one
 * agent denotes and `fleet_comms_inbox`'s seats source keeps only eligible
 * seats still carrying pending records as ranked inbox items; this tool is
 * the whole-roster read — every configured seat's projected lifecycle
 * state, handoff eligibility and pending (not yet journaled) handoff
 * records, including seats with nothing to move.
 *
 * No arguments: the seat store (`~/.phantom/bots`), the fleet coordination
 * root, the runs dir and the node store all stay server-owned, so unknown
 * keys, caller roots, paths and working directories are refused before the
 * plan runs. Read-only: the plan takes no writer lock and writes nothing —
 * unlike `phm bots seats`, whose roster read persists lifecycle transitions,
 * this projection never mutates seat state, releases claims or sends
 * notices, and `apply: false` stays on every ok result. A throwing plan
 * read — an unreadable or invalid roster, coordination table or node store —
 * reports `unavailable`, never an invented empty roster. Seat ids and
 * participant ids are routing labels, never authenticated identities; the
 * plan grants no claim, release, dispatch or execution authority.
 */
import { planSeatHandoffs, type SeatHandoffsPlan } from '../core/bots/seats.js';

/** The plan takes no caller input — every seat, fleet, runs and node root stays server-owned. */
export function parseFleetSeatHandoffsArgs(args: Record<string, unknown>): Record<string, never> | null {
  return Object.keys(args).length === 0 ? {} : null;
}

export interface FleetSeatHandoffsDeps {
  plan?: () => Promise<SeatHandoffsPlan>;
}

interface FleetSeatHandoffsMeta {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
}

/** The shared plan union with the MCP envelope metadata on every member. */
export type FleetSeatHandoffsResult = FleetSeatHandoffsMeta & (
  | SeatHandoffsPlan
  | { status: 'unavailable'; reason: 'seat-handoff-plan-unreadable' }
);

/**
 * One fleet-wide seat-handoff plan through the shared `planSeatHandoffs`
 * read — the identical projection `phm bots handoffs` runs, so per-seat
 * states, eligibility verdicts, deterministic handoff ids and pending
 * record contents can never diverge between the CLI and this tool. A
 * throwing plan read reports `unavailable` with its own reason — the same
 * honesty `work mine`'s seats section applies — never an empty roster
 * passed off as fact.
 */
export async function readFleetSeatHandoffs(
  deps: FleetSeatHandoffsDeps = {},
): Promise<FleetSeatHandoffsResult> {
  const plan = deps.plan ?? (() => planSeatHandoffs());
  const meta: FleetSeatHandoffsMeta = {
    schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
    generatedAt: new Date().toISOString(),
  };
  try {
    return { ...meta, ...(await plan()) };
  } catch {
    return { ...meta, status: 'unavailable' as const, reason: 'seat-handoff-plan-unreadable' as const };
  }
}
