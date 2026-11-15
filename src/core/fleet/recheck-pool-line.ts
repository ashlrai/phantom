/**
 * core/fleet/recheck-pool-line.ts: the one "Pool:" evidence line of the
 * paste-ready fleet recheck thread reply (see fleet-recheck-reply.ts).
 *
 * Pure: no I/O, no clock reads (the line carries the evidence's own asOf).
 * Every interpolated string goes through the caller's scrub. The line says
 * whether the node pool's primary and backup SSH aliases are reachable on the
 * tailnet; it is evidence, not a claim, and grants no failover authority.
 */
import type { PoolReach, PoolReachHost } from './pool-reach.js';

/** Whole-line budget; reasons are truncated to fit, host states never are. */
const LINE_MAX = 240;
/** Alias cap so a hostile alias cannot crowd out the host states. */
const ALIAS_MAX = 48;
const NOT_CONFIGURED = 'node pool not configured';
const SUFFIX = ' (tailnet evidence, not a claim)';

function hostText(h: PoolReachHost, scrub: (s: string) => string): string {
  const alias = scrub(String(h.alias)).slice(0, ALIAS_MAX);
  const state = h.online === true ? 'online' : h.online === false ? 'offline' : 'unknown';
  const seen = h.online === false && typeof h.lastSeen === 'string' && h.lastSeen !== 'unknown'
    ? ` (last seen ${scrub(h.lastSeen)})` : '';
  return `${h.slot} ${alias} ${state}${seen}${h.isSelf ? ' (this computer)' : ''}`;
}

/** Format node pool reachability evidence as one reply line. */
export function formatPoolLine(
  pool: PoolReach | null | undefined,
  scrub: (s: string) => string,
): string {
  if (pool === null || pool === undefined) return 'Pool: unknown (no pool evidence)';
  const reasons = Array.isArray(pool.reasons) ? pool.reasons : [];
  const hosts = Array.isArray(pool.hosts) ? pool.hosts : [];
  if (hosts.length === 0 && reasons.includes(NOT_CONFIGURED)) return 'Pool: not configured';
  const asOf = `as of ${scrub(String(pool.asOf))}`;
  if (hosts.length === 0) {
    const head = 'Pool: unknown';
    const tail = ` · ${asOf}${SUFFIX}`;
    const first = reasons[0];
    if (first === undefined) return `${head}${tail}`;
    const room = Math.max(0, LINE_MAX - head.length - tail.length - 3);
    return `${head} · ${scrub(String(first)).slice(0, room)}${tail}`;
  }
  return `Pool: ${hosts.map(h => hostText(h, scrub)).join(' · ')} · ${asOf}${SUFFIX}`;
}
