/**
 * core/fleet/fleet-recheck-reply.ts: turn a fleet.recheck.v1 verdict into a
 * short, paste-ready thread reply — the answer a reply worker can post when a
 * thread asks "can you reach live state". Backs `ashlr fleet recheck --reply`.
 *
 * The formatter is pure: no I/O, no clock reads, only the verdict's own asOf.
 * Output is one plain-text block capped at 900 characters: evidence lines
 * plus a verdict line. A "Computers:" evidence line (which fleet computers this
 * host sees on the tailnet; see recheck-computers-line.ts) follows the Runtime
 * line, then a "Pool:" line (node-pool reachability; see
 * recheck-pool-line.ts). An optional "Orders 24h:" evidence line (Mason's
 * inbox orders over the last 24h classified by order-trace; see
 * recheck-orders-line.ts) sits directly after the Task line when the verdict
 * carries orders evidence the trace could prove. An optional "Owners:" line
 * follows Bridge and names advisory bridge claimants. An optional "Peers:"
 * line follows Orders and reports peer bus budgets. When the reply would
 * exceed the cap, drop Peers, then per-channel coverage, then Owners, Orders, Pool, Computers,
 * then Running job, then Last verified, so the verdict line is never clipped.
 * One optional "Last verified:" evidence line sits
 * after the Peers line when the task section carries lastVerified (the newest
 * finished item with a named owner and claim receipt), dropped last of the
 * three. One optional "Running job:" line follows it (dropped before Last
 * verified) when task.liveWorker carries process-table evidence; it is
 * explicitly not a claim. A VERIFIED reply closes with "Evidence only; this reply
 * grants no dispatch."; anything else names what is missing. The words
 * 'routed' and 'dispatched' never appear — evidence is observed, not claimed.
 *
 * Every interpolated value is sanitized again here, not trusted from upstream:
 * IPv4/IPv6 via sanitizeIdentityText and the /Users|/home/<name> path shape via
 * a regex, so a hand-built verdict carrying another user's home path cannot
 * leak it into a thread reply.
 */
import type { FleetRecheck } from './fleet-recheck.js';
import { formatComputersLine } from './recheck-computers-line.js';
import { formatPeersLine } from './recheck-peers-line.js';
import { formatOrdersLine } from './recheck-orders-line.js';
import { formatOwnersLine } from './recheck-owners-line.js';
import { formatPoolLine } from './recheck-pool-line.js';
import { sanitizeIdentityText } from './runtime-identity.js';

/** Hard cap on the whole reply, including the trailing ellipsis when clipped. */
const REPLY_MAX = 900;
/** Claims named in the reply; the ledger itself already caps the top list. */
const TOP_CLAIMS = 3;
/**
 * Home-dir shape from any user — /Users/<name>, /home/<name>. A verdict not
 * produced by readFleetRecheck can carry a path sanitizeIdentityText would not
 * know to strip, so the shape itself is redacted to '~'.
 */
const HOME_PATH = /\/(?:Users|home)\/[^/\s;,)]+/g;
/** The reply contract forbids these words even inside an evidence string. */
const FORBIDDEN_WORDS = /\b(?:routed|dispatched)\b/gi;

/** Redact home paths, IP addresses and contract-banned words from one value. */
function scrub(value: string): string {
  return sanitizeIdentityText(value.replace(HOME_PATH, '~'), '').replace(FORBIDDEN_WORDS, '[verb]');
}

/**
 * Bounded per-channel request-coverage evidence lines (at most one per
 * required channel, fixed length for any count): 'unproven' with a positive
 * pending count names the exact gap, 'verified' says recent requests answered
 * in thread, and 'idle' or 'unknown' (the no-bridge-evidence placeholder)
 * prints nothing. Evidence only: the lines never change a state, the verdict
 * line or the cap handling, and they are dropped after Peers when the
 * reply would exceed the cap.
 */
function coverageLines(
  channels: FleetRecheck['sections']['bridge']['channels'],
): string[] {
  return channels
    .filter(c => c.channel === 'slack' || c.channel === 'imessage')
    .map(c => {
      const label = c.channel === 'slack' ? 'Slack' : 'IMessage';
      if (c.requestCoverage === 'unproven' && typeof c.unansweredCount === 'number' && c.unansweredCount > 0) {
        return `${label}: ${c.unansweredCount} ${c.unansweredCount === 1 ? 'request' : 'requests'} without a bound reply`;
      }
      if (c.requestCoverage === 'verified') return `${label}: recent requests answered in thread`;
      return null;
    })
    .filter((line): line is string => line !== null);
}

/** Format a fleet recheck verdict as one paste-ready thread reply. */
export function formatRecheckReply(r: FleetRecheck): string {
  const { runtime, claims, bridge, task } = r.sections;
  const channel = (name: 'slack' | 'imessage'): string =>
    bridge.channels.find(c => c.channel === name)?.state ?? 'absent';
  const age = typeof runtime.fleetState.ageSeconds === 'number'
    ? `${runtime.fleetState.ageSeconds}s`
    : 'unknown';
  const top = claims.top.slice(0, TOP_CLAIMS)
    .map(c => `${scrub(c.agent)}/${scrub(c.repo)}`).join(', ') || 'none';
  const missing = r.overall.missing.map(scrub).join('; ') || 'no missing detail';
  const lv = task.lastVerified ?? null;
  const lastVerified = lv === null ? null
    : `Last verified: ${scrub(lv.id)} · owner ${scrub(lv.owner)} · claim ${scrub(lv.claimReceipt)} · as of ${scrub(lv.asOf)} (evidence only)`;
  const lw = task.liveWorker ?? null;
  const running = lw === null ? null
    : `Running job: ${scrub(lw.job)} · ${scrub(lw.repo)} · lane ${scrub(lw.lane)}/${scrub(lw.tier)}`
      + ` · up ${lw.ageSeconds === null ? 'unknown' : `${lw.ageSeconds}s`} · as of ${scrub(lw.asOf)} (process evidence, not a claim)`;
  const computers = formatComputersLine(r.tailnet, scrub);
  const pool = formatPoolLine(r.pool, scrub);
  const orders = formatOrdersLine(r.orders, scrub);
  const peers = formatPeersLine(r.peers, scrub);
  const coverage = coverageLines(bridge.channels);
  const owners = formatOwnersLine(r.owners, scrub);
  const build = (withOrders: boolean, withLast: boolean, withRunning: boolean, withComputers: boolean, withPool = false, withOwners = false, withCoverage = false, withPeers = false): string => [
    `Phantom recheck ${r.overall.state} · as of ${scrub(r.asOf)} · source fleet-recheck`,
    `Runtime: ${scrub(runtime.host)} · ${scrub(runtime.installedVersion)} · fleet state ${age}`
      + `${runtime.fleetState.stale === true ? ' · stale' : ''} (${runtime.state})`,
    ...(withComputers && computers !== null ? [computers] : []),
    ...(withPool ? [pool] : []),
    `Claims: ${claims.active === null ? 'unknown' : claims.active} live, top: ${top} (${claims.state})`,
    `Bridge: slack ${channel('slack')}, imessage ${channel('imessage')}`
      + `${bridge.missingBridge === null ? '' : ` · missing: ${scrub(bridge.missingBridge)}`} (${bridge.state})`,
    ...(withOwners && owners !== null ? [owners] : []),
    ...(withCoverage ? coverage : []),
    task.task === null
      ? `Task: none, ${scrub(task.missing[0] ?? 'no task evidence')} (${task.state})`
      : `Task: ${scrub(task.task.id)} ${task.task.state} · owner ${scrub(task.task.owner)} · claim ${scrub(task.task.claimReceipt)} (${task.state})`,
    ...(withOrders && orders !== null ? [orders] : []),
    ...(withPeers && peers !== null ? [peers] : []),
    ...(withLast && lastVerified !== null ? [lastVerified] : []),
    ...(withRunning && running !== null ? [running] : []),
    r.overall.state === 'VERIFIED'
      ? 'Evidence only; this reply grants no dispatch.'
      : r.overall.state === 'BLOCKED'
        ? `BLOCKED on: ${missing}`
        : `UNKNOWN: ${missing}`,
  ].join('\n');
  // Drop optional evidence in this order, keeping the verdict line whole:
  // Peers, coverage, Owners, Orders, Pool, Computers, Running job, Last verified.
  let text = build(true, true, true, true, true, true, true, true);
  if (text.length > REPLY_MAX) text = build(true, true, true, true, true, true, true, false);
  if (text.length > REPLY_MAX) text = build(true, true, true, true, true, true, false, false);
  if (text.length > REPLY_MAX) text = build(true, true, true, true, true, false, false, false);
  if (text.length > REPLY_MAX) text = build(false, true, true, true, true, false, false, false);
  if (text.length > REPLY_MAX) text = build(false, true, true, true, false, false, false, false);
  if (text.length > REPLY_MAX) text = build(false, true, true, false, false, false, false, false);
  if (text.length > REPLY_MAX) text = build(false, true, false, false, false, false, false, false);
  if (text.length > REPLY_MAX) text = build(false, false, false, false, false, false, false, false);
  // Oversized core evidence must not crowd out a complete verdict line.
  // An oversized verdict reason itself retains the existing ellipsis cap.
  if (text.length > REPLY_MAX) {
    const verdict = text.slice(text.lastIndexOf('\n') + 1);
    if (verdict.length < REPLY_MAX - 1) {
      return `${text.slice(0, REPLY_MAX - verdict.length - 2)}…\n${verdict}`;
    }
  }
  return text.length <= REPLY_MAX ? text : `${text.slice(0, REPLY_MAX - 1)}…`;
}
