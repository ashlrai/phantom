/**
 * Bus hop log tail read — the one typed read behind `phm fleet bus-hops` and
 * the isolated fleet MCP `fleet_bus_hops` tool. A hop is a recorded send
 * attempt: message id, from/to routing labels and nullable token usage —
 * never a body, delivery claim or lifecycle state. Missing and unreadable
 * stores stay distinct and neither invents rows; token subtotals keep
 * unknown samples separate rather than counting them as zero.
 */
import { BUS_HOPLOG_TAIL_MAX_ROWS, readBusHoplogTail } from './bus-hoplog.js';
import { summarizeBusHops, type BusHopSummary } from './bus-hop-summary.js';
import { agentRefAddressMatcher, readAgentRegistry } from '../agents/bus-identity.js';

/** Newest matching hops a read returns; `matched` keeps the filtered count in the scanned window. */
export const FLEET_BUS_HOPS_LIMIT_MAX = 50;

/**
 * `fleet bus-hops` arguments. `from`/`to`/`excludeFrom` are routing-label refs
 * resolved through the identity registry — the same `agentRefAddressMatcher`
 * rule `fleet_bus_inbox`'s address filters apply, so a ref naming one
 * registered identity matches every label that identity answers to and an
 * unresolvable ref or unreadable registry keeps exact-label matching. `id`
 * keeps only the hop whose message id is strictly equal. The hop log carries
 * no timestamps, so there is deliberately no `since`/`before`: position in
 * the append order is the only ordering the store proves.
 */
export interface BusHopsFilters {
  /** Newest matching hops to return, oldest first; `matched` keeps the filtered count in the scanned window. */
  limit?: number;
  /** Sender ref — handle, `agent:<handle>`, stable id or alias — matched against every label of the resolved identity. */
  from?: string;
  /** Recipient ref under the same identity-label rule as `from`. */
  to?: string;
  /** Sender ref to drop under the same identity-label rule, inverted — it composes with `from` so a sender both included and excluded matches nothing. */
  excludeFrom?: string;
  /** Keep only the hop whose message id is strictly equal to this value — never a substring. */
  id?: string;
}

export interface BusHopsView {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
  /** 'missing' a verified-absent log, 'unreadable' a present log that failed custody, 'ok' a validated tail. */
  sourceState: 'missing' | 'unreadable' | 'ok';
  /** On-disk byte size when the log passed custody checks; else null. */
  logBytes: number | null;
  limit: number;
  /** Newest `limit` matches oldest-first; null unless sourceState is 'ok'. */
  hops: ReadonlyArray<{ id: string; from: string; to: string; inputTokens: number | null; outputTokens: number | null }> | null;
  /** Filter hits inside the scanned window — a lower bound when `truncated` reports rows beyond it, never a fleet-wide total. */
  matched: number | null;
  usageSummary: BusHopSummary | null;
  returnedHops: number | null;
  skippedRows: number | null;
  truncated: boolean | null;
}

/**
 * The bounded tail read both surfaces share: one scan of the hop log's read
 * window (`BUS_HOPLOG_TAIL_MAX_ROWS`), then the optional `from`/`to`/
 * `excludeFrom`/`id` filters, then the newest `limit` matches oldest-first.
 * `matched` counts filter hits inside that scanned window — a lower bound
 * when `truncated` reports rows beyond it. Usage totals are subtotals of the
 * returned tail's recorded attempts, not provider usage or proof of
 * delivery; unknown samples remain separate.
 */
export function readFleetBusHops(input: BusHopsFilters = {}): BusHopsView {
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > FLEET_BUS_HOPS_LIMIT_MAX) {
    throw new RangeError(`Bus hop limit must be an integer between 1 and ${FLEET_BUS_HOPS_LIMIT_MAX}.`);
  }
  const tail = readBusHoplogTail(BUS_HOPLOG_TAIL_MAX_ROWS);
  const meta = {
    schemaVersion: 1 as const, snapshotKind: 'local-persisted' as const,
    authority: 'none' as const, generatedAt: new Date().toISOString(),
    sourceState: tail.state, logBytes: tail.logBytes, limit,
  };
  if (tail.state !== 'ok' || tail.hops === null) {
    return { ...meta, hops: null, matched: null, usageSummary: null,
      returnedHops: null, skippedRows: null, truncated: null };
  }
  const registryRead = input.from === undefined && input.to === undefined && input.excludeFrom === undefined
    ? undefined : readAgentRegistry();
  const registry = registryRead?.status === 'ok' ? registryRead.registry : undefined;
  const from = input.from === undefined ? undefined : agentRefAddressMatcher(input.from, registry);
  const to = input.to === undefined ? undefined : agentRefAddressMatcher(input.to, registry);
  const excludeFrom = input.excludeFrom === undefined ? undefined : agentRefAddressMatcher(input.excludeFrom, registry);
  const matchedHops = tail.hops.filter(hop =>
    (from === undefined || from(hop.from)) &&
    (to === undefined || to(hop.to)) &&
    (excludeFrom === undefined || !excludeFrom(hop.from)) &&
    (input.id === undefined || hop.id === input.id));
  const page = matchedHops.slice(-limit);
  const hops = page.map(hop => ({
    id: hop.id, from: hop.from, to: hop.to,
    inputTokens: hop.inputTokens, outputTokens: hop.outputTokens,
  }));
  return {
    ...meta, sourceState: 'ok' as const, hops, matched: matchedHops.length,
    usageSummary: summarizeBusHops(hops), returnedHops: hops.length,
    skippedRows: tail.skippedRows,
    truncated: (tail.truncated ?? false) || matchedHops.length > hops.length,
  };
}
