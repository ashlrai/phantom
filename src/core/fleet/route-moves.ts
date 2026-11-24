/**
 * core/fleet/route-moves.ts — dispatcher route moves and refusals from
 * dispatch-events.log. Backs `phm fleet route-moves [--hours N] [--json]`.
 *
 * The log is append-only and never compacted, so readers fold it line by
 * line: memory stays flat at the in-window ROUTE lines however large the
 * ledger grows. Events use local wall time as written by dispatchd; lines
 * that do not parse or fall outside the window are skipped, never thrown.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { localTimestamp } from './runs-parked-queue.js';

export interface RouteMove { at: string; id: string; from: string; to: string; tier: string; refused: boolean }
export interface RouteMovesReport {
  schema: 'fleet.route-moves.v1'; hours: number; windowStart: string; windowEnd: string;
  moves: number; refused: number;
  pairs: Array<{ from: string; to: string; moves: number; refused: number }>;
  tiers: Array<{ tier: string; moves: number; refused: number }>;
  latest: RouteMove[];
}

const ROUTE_LINE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (ROUTE|ROUTE_REFUSED) ([\w.-]+) ([\w.-]+) -> ([\w.-]+) \(tier ([\w.-]+)(?: (not accepted))?\)$/;

export interface RouteMoveTally {
  /** Fold one dispatch-events.log line; unparseable and out-of-window lines are skipped. */
  add(line: string): void;
  report(): RouteMovesReport;
}

/** Incremental fold of the ROUTE/ROUTE_REFUSED lines inside [now-hours, now]. */
export function routeMoveTally(hours: number, now: number): RouteMoveTally {
  const since = now - hours * 3_600_000;
  const events: RouteMove[] = [];
  const pairs = new Map<string, RouteMovesReport['pairs'][number]>();
  const tiers = new Map<string, RouteMovesReport['tiers'][number]>();
  return {
    add(line: string) {
      const m = ROUTE_LINE.exec(line);
      if (!m || (m[2] === 'ROUTE' && m[7]) || (m[2] === 'ROUTE_REFUSED' && !m[7])) return;
      const ms = localTimestamp(m[1]!).ms;
      if (!Number.isFinite(ms) || ms < since || ms > now) return;
      const event: RouteMove = { at: new Date(ms).toISOString(), id: m[3]!, from: m[4]!, to: m[5]!, tier: m[6]!, refused: m[2] === 'ROUTE_REFUSED' };
      events.push(event);
      const key = `${event.from}\0${event.to}`;
      const pair = pairs.get(key) ?? { from: event.from, to: event.to, moves: 0, refused: 0 };
      const tier = tiers.get(event.tier) ?? { tier: event.tier, moves: 0, refused: 0 };
      if (event.refused) { pair.refused++; tier.refused++; } else { pair.moves++; tier.moves++; }
      pairs.set(key, pair); tiers.set(event.tier, tier);
    },
    report() {
      const moves = events.filter(event => !event.refused);
      return { schema: 'fleet.route-moves.v1', hours, windowStart: new Date(since).toISOString(), windowEnd: new Date(now).toISOString(),
        moves: moves.length, refused: events.length - moves.length,
        pairs: [...pairs.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
        tiers: [...tiers.values()].sort((a, b) => a.tier.localeCompare(b.tier)),
        latest: moves.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10) };
    },
  };
}

/** Parse only dispatcher route records with valid local timestamps in the requested window. */
export function routeMoves(text: string, hours = 6, now = Date.now()): RouteMovesReport {
  const tally = routeMoveTally(hours, now);
  for (const line of text.split(/\r?\n/)) tally.add(line);
  return tally.report();
}

/** Stream dispatch-events.log line by line; a missing or failed read rejects like readFile did. */
export async function readRouteMoves(path: string, hours = 6, now = Date.now()): Promise<RouteMovesReport> {
  const tally = routeMoveTally(hours, now);
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) tally.add(line);
  return tally.report();
}
