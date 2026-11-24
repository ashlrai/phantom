/**
 * Read-only physical-host rollup over the compute nodes (RQ-VIZ-NODECAP-1).
 *
 * Node-pool records carry no hostname, so several workers on one Mac (mbp-w1, mbp-w2) are grouped
 * only on evidence two workers on different Macs cannot share: identical RAM total, identical core
 * count and a boot time (sampledAt - uptime) within BOOT_TOLERANCE_MS. Nodes without host-stats are
 * never grouped and never counted as zero: they stay out of `hosts` and are reported as unplaced.
 * Pool logic (slots, held, routing) is untouched; this only sums what nodes already advertise.
 */
import { nodeRamSlots } from '../drive/nodes/capacity.js';
import type { ComputeNode } from './compute-view.js';

export const BOOT_TOLERANCE_MS = 10_000;

export interface ComputeHost {
  /** Stable id: the lexicographically first member node id. */
  id: string;
  nodeIds: string[];
  /** True only when more than one node was joined by the boot-time evidence. */
  inferred: boolean;
  ramTotal: number;
  cores: number;
  observedAt: number;
  caps: string[];
  /** Workers currently ready (live heartbeat), and sum of their advertised slots; null when any is unreported. */
  liveWorkers: number;
  liveSlots: number | null;
  /** Live workers advertising zero slots: admission held (the reason is not recorded in the node record). */
  heldWorkers: number;
  /** Running claims held by member nodes. */
  claims: number;
  /** Slots the RAM budget alone would allow for this host (not the sum of per-worker budgets). */
  ramSlots: number;
  /** liveSlots > ramSlots; null when liveSlots is unknown. */
  oversubscribed: boolean | null;
}
export interface ComputePoolTotals {
  hosts: number; liveWorkers: number; liveSlots: number | null; ramSlots: number; claims: number;
  /** Nodes with no host-stats: not placed on any host, slots not summed into host rows. */
  unplacedNodes: number; oversubscribedHosts: number;
}

const bootOf = (n: ComputeNode) => n.stats ? n.stats.sampledAtMs - n.stats.uptimeSeconds * 1000 : NaN;

export function summarizeHosts(nodes: ComputeNode[]): { hosts: ComputeHost[]; totals: ComputePoolTotals } {
  const placed = nodes.filter(n => n.stats && !n.id.startsWith('@local:') && Number.isFinite(bootOf(n)));
  const byShape = new Map<string, ComputeNode[]>();
  for (const n of placed) {
    const key = `${n.stats!.ramTotal}/${n.stats!.cores.length}`;
    byShape.set(key, [...(byShape.get(key) ?? []), n]);
  }
  const groups: ComputeNode[][] = [];
  for (const members of byShape.values()) {
    members.sort((a, b) => bootOf(a) - bootOf(b));
    for (const n of members) {
      const last = groups.at(-1);
      const sameShape = last && last[0]!.stats!.ramTotal === n.stats!.ramTotal && last[0]!.stats!.cores.length === n.stats!.cores.length;
      if (sameShape && bootOf(n) - bootOf(last[last.length - 1]!) <= BOOT_TOLERANCE_MS) last.push(n);
      else groups.push([n]);
    }
  }
  const hosts = groups.map((g): ComputeHost => {
    const live = g.filter(n => n.state === 'ready');
    const liveSlots = live.some(n => n.slots === null) ? null : live.reduce((sum, n) => sum + n.slots!, 0);
    const ramSlots = nodeRamSlots(g[0]!.stats!.ramTotal);
    const ids = g.map(n => n.id).sort();
    return { id: ids[0]!, nodeIds: ids, inferred: g.length > 1, ramTotal: g[0]!.stats!.ramTotal, cores: g[0]!.stats!.cores.length,
      observedAt: Math.max(...g.map(n => n.stats!.sampledAtMs)), caps: [...new Set(g.flatMap(n => n.caps ?? []))].sort(),
      liveWorkers: live.length, liveSlots, heldWorkers: live.filter(n => n.slots === 0).length,
      claims: g.reduce((sum, n) => sum + n.jobs.length, 0), ramSlots, oversubscribed: liveSlots === null ? null : liveSlots > ramSlots };
  }).sort((a, b) => a.id < b.id ? -1 : 1);
  const unknownSlots = hosts.some(h => h.liveSlots === null);
  return { hosts, totals: {
    hosts: hosts.length, liveWorkers: hosts.reduce((s, h) => s + h.liveWorkers, 0),
    liveSlots: unknownSlots ? null : hosts.reduce((s, h) => s + h.liveSlots!, 0), ramSlots: hosts.reduce((s, h) => s + h.ramSlots, 0),
    claims: hosts.reduce((s, h) => s + h.claims, 0), unplacedNodes: nodes.length - placed.length,
    oversubscribedHosts: hosts.filter(h => h.oversubscribed === true).length } };
}
