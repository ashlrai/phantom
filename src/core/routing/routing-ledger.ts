/**
 * Per-run routing accounting for `phm status --json`: which tier and engine
 * each seat got, and why (the P4 lane reason). Bounded, value-free: ids,
 * engine names, tiers and closed reason codes only. Never throws.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ashlrRoot } from './budget-store.js';
import { classifyEngine, type EngineClass, type LocalRouteContext } from './local-route.js';
import type { SeatDecision } from './types.js';

export const ROUTING_LEDGER_MAX = 100;

export interface RoutingLedgerEntry {
  at: string;
  itemId: string;
  seatId: string | null;
  engine: string;
  engineClass: EngineClass;
  lane: 'local' | 'frontier';
  reason: string;
}

export interface RoutingLedger {
  schemaVersion: 1;
  entries: RoutingLedgerEntry[];
  counts: { local: number; frontier: number; unclassified: number };
}

export function routingLedgerPath(): string {
  return join(ashlrRoot(), 'routing', 'last-run.json');
}

/** Pure. One ledger entry from a dispatch decision. */
export function routingLedgerEntry(
  itemId: string,
  engine: string,
  decision: SeatDecision | null,
  engines: LocalRouteContext['engines'],
  now: Date = new Date(),
): RoutingLedgerEntry {
  const d = (decision ?? {}) as Partial<SeatDecision> & { lane?: 'local' | 'frontier'; laneReason?: string };
  return {
    at: now.toISOString(),
    itemId,
    seatId: d.seatId ?? null,
    engine: String(engine),
    engineClass: classifyEngine({ engine } as never, engines),
    lane: d.lane ?? 'frontier',
    reason: d.laneReason ?? 'policy-off',
  };
}

/** Pure. Appends and bounds; counts are by engine class. */
export function appendRoutingLedger(prev: RoutingLedger | null, entry: RoutingLedgerEntry): RoutingLedger {
  const entries = [...(prev?.entries ?? []).filter((e) => e.itemId !== entry.itemId), entry].slice(-ROUTING_LEDGER_MAX);
  const counts = { local: 0, frontier: 0, unclassified: 0 };
  for (const e of entries) counts[e.engineClass]++;
  return { schemaVersion: 1, entries, counts };
}

export function readRoutingLedger(path = routingLedgerPath()): RoutingLedger | null {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as RoutingLedger;
    return v && v.schemaVersion === 1 && Array.isArray(v.entries) ? v : null;
  } catch { return null; }
}

export function recordRoutingDecision(
  itemId: string,
  engine: string,
  decision: SeatDecision | null,
  engines: LocalRouteContext['engines'],
  path = routingLedgerPath(),
): void {
  try {
    const next = appendRoutingLedger(readRoutingLedger(path), routingLedgerEntry(itemId, engine, decision, engines));
    mkdirSync(join(path, '..'), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    renameSync(tmp, path);
  } catch { /* accounting never blocks dispatch */ }
}
