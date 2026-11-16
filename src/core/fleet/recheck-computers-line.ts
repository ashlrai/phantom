/**
 * core/fleet/recheck-computers-line.ts: the one "Computers:" evidence line of
 * the paste-ready fleet recheck thread reply (see fleet-recheck-reply.ts).
 *
 * Pure: no I/O, no clock reads (the line carries the tailnet evidence's own
 * asOf). Every interpolated string goes through the caller's scrub, so the
 * reply's redaction rules (IPs, home paths, banned verbs) apply here too. The
 * line is tailnet evidence about which computers this host can see; it is not
 * a claim and grants nothing.
 */
import type { FleetRecheckTailnet } from './fleet-recheck.js';

/** Peer names listed in the line; the rest are summarised as "+N". */
const SEEN_MAX = 3;

/** Format tailnet evidence as one reply line. Never returns null today; the
 * nullable type leaves room to omit the line without changing callers. */
export function formatComputersLine(
  tailnet: FleetRecheckTailnet | null | undefined,
  scrub: (s: string) => string,
): string | null {
  if (tailnet === null || tailnet === undefined) return 'Computers: unknown (no tailnet evidence)';
  const counted = tailnet.online + tailnet.offline + tailnet.unknown;
  const shown = tailnet.peers.slice(0, SEEN_MAX).map(p => scrub(p.name));
  const more = Math.max(counted, tailnet.peers.length) - shown.length;
  const parts = [
    `Computers: ${tailnet.online} online, ${tailnet.offline} offline${tailnet.unknown > 0 ? `, ${tailnet.unknown} unknown` : ''}`,
    `self ${scrub(tailnet.self)}`,
    `seen: ${shown.length === 0 ? 'none' : shown.join(', ')}${more > 0 ? ` +${more}` : ''}`,
    `as of ${scrub(tailnet.asOf)}`,
  ];
  const reason = counted === 0 ? tailnet.reasons[0] : undefined;
  if (reason !== undefined) parts.push(scrub(reason));
  return `${parts.join(' · ')} (tailnet evidence, not a claim)`;
}
