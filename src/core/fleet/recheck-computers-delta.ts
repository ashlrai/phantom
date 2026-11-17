/**
 * core/fleet/recheck-computers-delta.ts: pure comparison of the bounded
 * tailnet computer evidence two recheck records retained. Names which fleet
 * computers went offline or came back online between an older row and a
 * newer one, so history can say the fleet changed and not just that it
 * rechecked.
 *
 * Comparable only when both rows carry tailnet evidence. A peer listed
 * online in the older row counts as wentOffline when the newer row lists it
 * offline, or drops it while the newer peer list is under the cap — a list
 * at the cap may have pushed a still-online peer out of view, so absence
 * there is inconclusive. The mirror holds for cameOnline. 'unknown' is
 * neither online nor offline. Reads no clock and never throws.
 */
import { RECHECK_TAILNET_PEERS_MAX, type RecheckRecord, type RecheckTailnet } from './recheck-record.js';

export interface RecheckComputersDelta {
  /** Sorted peer names that were online in the older row and are no longer. */
  wentOffline: string[];
  /** Sorted peer names that are online in the newer row and were not before. */
  cameOnline: string[];
  /** The older row's asOf when comparable; null otherwise. */
  since: string | null;
  /** True only when both rows carry tailnet evidence. */
  comparable: boolean;
}

function peersOf(t: RecheckTailnet): Map<string, boolean | 'unknown'> {
  const map = new Map<string, boolean | 'unknown'>();
  for (const p of t.peers) {
    if (!map.has(p.name)) map.set(p.name, p.online);
  }
  return map;
}

export function computersDelta(newer: RecheckRecord, older: RecheckRecord | null): RecheckComputersDelta {
  const none = (): RecheckComputersDelta => ({ wentOffline: [], cameOnline: [], since: null, comparable: false });
  try {
    const nt = newer?.sections?.tailnet ?? null;
    const ot = older?.sections?.tailnet ?? null;
    if (nt === null || ot === null) return none();
    const olderPeers = peersOf(ot);
    const newerPeers = peersOf(nt);
    const newerComplete = nt.peers.length < RECHECK_TAILNET_PEERS_MAX;
    const olderComplete = ot.peers.length < RECHECK_TAILNET_PEERS_MAX;
    const wentOffline: string[] = [];
    const cameOnline: string[] = [];
    for (const [name, was] of olderPeers) {
      const now = newerPeers.get(name);
      if (was === true && (now === false || (now === undefined && newerComplete))) wentOffline.push(name);
      else if (was === false && now === true) cameOnline.push(name);
    }
    if (olderComplete) {
      for (const [name, now] of newerPeers) {
        if (now === true && !olderPeers.has(name)) cameOnline.push(name);
      }
    }
    return { wentOffline: wentOffline.sort(), cameOnline: cameOnline.sort(), since: older?.asOf ?? null, comparable: true };
  } catch {
    return none();
  }
}
