/**
 * `fleet_bot_seats` MCP adapter: the bot-seat roster — `readBotSeats`, the
 * same seat-view projection `phm bots seats --json` serves minus its
 * persist-on-read lifecycle write, where `fleet_seat_handoffs` reports only
 * the handoff plan (seatId, participantId, state, eligible, pending
 * records) and `fleet_agent_work` narrows that plan to one agent's seats,
 * so no existing tool answers "which seats can accept new work right now"
 * — per-seat quota evidence, projected lifecycle state, `acceptsNewWork`
 * and open claims/jobs — in one call.
 *
 * No arguments: the seat store (`~/.phantom/bots`), the fleet coordination
 * root, the runs dir and the node store all stay server-owned, so unknown
 * keys, caller roots, paths and working directories are refused before the
 * roster read runs. Read-only: `readBotSeats` takes no writer lock and
 * writes nothing — unlike `listSeats`, which persists projected lifecycle
 * transitions back to seat-state.json, this projection never mutates seat
 * state, releases claims or sends notices. Seat `secretHandle` names and
 * adapter internals stay out of the result: handles are routing metadata,
 * never values the fleet surface echoes. A throwing roster read — an
 * unreadable or invalid roster, coordination table or node store — reports
 * `unavailable`, never an invented empty roster. Seat ids, participant ids,
 * claim keys and owners are routing labels, never authenticated identities;
 * quota evidence is measured or unknown-with-reason, never an invented
 * zero, and the roster grants no claim, release, dispatch or execution
 * authority.
 */
import { readBotSeats, type BotSeatsRoster } from '../core/bots/seats.js';

/** The roster takes no caller input — every seat, fleet, runs and node root stays server-owned. */
export function parseFleetBotSeatsArgs(args: Record<string, unknown>): Record<string, never> | null {
  return Object.keys(args).length === 0 ? {} : null;
}

export interface FleetBotSeatsDeps {
  seats?: () => Promise<BotSeatsRoster>;
}

interface FleetBotSeatsMeta {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
}

/** One roster seat minus the fields the fleet surface never echoes: the
 * configured secret handle name and the adapter's internal status record. */
export type FleetBotSeatEntry = Omit<BotSeatsRoster['seats'][number], 'secretHandle' | 'adapter'>;

/** The shared roster union with the MCP envelope metadata on every member. */
export type FleetBotSeatsResult = FleetBotSeatsMeta & (
  | { schema: 'phantom-bot-seats.v1'; persisted: false; seats: FleetBotSeatEntry[] }
  | { status: 'unavailable'; reason: 'bot-seat-roster-unreadable' }
);

/**
 * One fleet-wide seat roster through the shared `readBotSeats` read — the
 * identical seat views `phm bots seats` computes, minus the lifecycle
 * persist that makes the CLI roster read a write. `persisted: false` stays
 * on every ok result as the explicit contract that this surface never
 * mutates seat state. A throwing roster read reports `unavailable` with its
 * own reason — the same honesty `fleet_seat_handoffs` applies — never an
 * empty roster passed off as fact.
 */
export async function readFleetBotSeats(
  deps: FleetBotSeatsDeps = {},
): Promise<FleetBotSeatsResult> {
  const seats = deps.seats ?? (() => readBotSeats());
  const meta: FleetBotSeatsMeta = {
    schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
    generatedAt: new Date().toISOString(),
  };
  try {
    const roster = await seats();
    return {
      ...meta, schema: 'phantom-bot-seats.v1' as const, persisted: false as const,
      seats: roster.seats.map(({ secretHandle: _handle, adapter: _adapter, ...entry }) => entry),
    };
  } catch {
    return { ...meta, status: 'unavailable' as const, reason: 'bot-seat-roster-unreadable' as const };
  }
}
