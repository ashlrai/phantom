import { createBusHop } from './bus-hoplog.js';
import type { BusHop } from './bus-hoplog.js';

/** A subtotal of reported counts, with missing samples kept separate. */
export interface BusHopTokenSummary {
  /** Sum of known samples, or null if that sum exceeds Number.MAX_SAFE_INTEGER. */
  total: number | null;
  overflow: boolean;
  knownSamples: number;
  unknownSamples: number;
}

export interface BusHopUsageSummary {
  hopCount: number;
  input: BusHopTokenSummary;
  output: BusHopTokenSummary;
}

export interface BusHopGroupSummary extends BusHopUsageSummary {
  /** Validated sender or recipient identifier. */
  id: string;
}

export interface BusHopSummary extends BusHopUsageSummary {
  invalidHopCount: number;
  bySender: BusHopGroupSummary[];
  byRecipient: BusHopGroupSummary[];
}

function usage(): BusHopUsageSummary {
  const tokens = (): BusHopTokenSummary => ({ total: 0, overflow: false, knownSamples: 0, unknownSamples: 0 });
  return { hopCount: 0, input: tokens(), output: tokens() };
}

function addTokens(summary: BusHopTokenSummary, count: number | null): void {
  if (count === null) {
    summary.unknownSamples++;
    return;
  }
  summary.knownSamples++;
  if (summary.total !== null) {
    if (count > Number.MAX_SAFE_INTEGER - summary.total) {
      summary.total = null;
      summary.overflow = true;
    } else {
      summary.total += count;
    }
  }
}

function addHop(summary: BusHopUsageSummary, hop: Readonly<BusHop>): void {
  summary.hopCount++;
  addTokens(summary.input, hop.inputTokens);
  addTokens(summary.output, hop.outputTokens);
}

function addGroup(groups: Map<string, BusHopGroupSummary>, id: string, hop: Readonly<BusHop>): void {
  let group = groups.get(id);
  if (!group) {
    group = { id, ...usage() };
    groups.set(id, group);
  }
  addHop(group, hop);
}

function sortedGroups(groups: Map<string, BusHopGroupSummary>): BusHopGroupSummary[] {
  return [...groups.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Summarize validated hop observations without reading bodies or deduplicating IDs.
 * Totals cover only known samples; an empty known set has subtotal 0 and is
 * distinguishable by knownSamples. Missing samples are never treated as reported
 * zero. Groups are sorted by identifier in code-unit order, independent of locale.
 */
export function summarizeBusHops(rows: readonly unknown[]): BusHopSummary {
  const summary: BusHopSummary = { ...usage(), invalidHopCount: 0, bySender: [], byRecipient: [] };
  const senders = new Map<string, BusHopGroupSummary>();
  const recipients = new Map<string, BusHopGroupSummary>();
  for (const row of rows) {
    const hop = createBusHop(row, row);
    if (!hop) {
      summary.invalidHopCount++;
      continue;
    }
    addHop(summary, hop);
    addGroup(senders, hop.from, hop);
    addGroup(recipients, hop.to, hop);
  }
  summary.bySender = sortedGroups(senders);
  summary.byRecipient = sortedGroups(recipients);
  return summary;
}
