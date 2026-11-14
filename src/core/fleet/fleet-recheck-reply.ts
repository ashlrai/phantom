/**
 * core/fleet/fleet-recheck-reply.ts: turn a fleet.recheck.v1 verdict into a
 * short, paste-ready thread reply — the answer a reply worker can post when a
 * thread asks "can you reach live state". Backs `ashlr fleet recheck --reply`.
 *
 * The formatter is pure: no I/O, no clock reads, only the verdict's own asOf.
 * Output is one plain-text block capped at 900 characters: five evidence lines
 * plus a verdict line. A "Computers:" evidence line (which fleet computers this
 * host sees on the tailnet; see recheck-computers-line.ts) follows the Runtime
 * line. It is the first line dropped when the reply would exceed the cap, then
 * Running job, then Last verified, so the verdict line is never clipped.
 * One optional "Last verified:" evidence line sits
 * after the Task line when the task section carries lastVerified (the newest
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
  const build = (withLast: boolean, withRunning: boolean, withComputers: boolean, withPool = false): string => [
    `Phantom recheck ${r.overall.state} · as of ${scrub(r.asOf)} · source fleet-recheck`,
    `Runtime: ${scrub(runtime.host)} · ${scrub(runtime.installedVersion)} · fleet state ${age}`
      + `${runtime.fleetState.stale === true ? ' · stale' : ''} (${runtime.state})`,
    ...(withComputers && computers !== null ? [computers] : []),
    ...(withComputers && withPool ? [pool] : []),
    `Claims: ${claims.active === null ? 'unknown' : claims.active} live, top: ${top} (${claims.state})`,
    `Bridge: slack ${channel('slack')}, imessage ${channel('imessage')}`
      + `${bridge.missingBridge === null ? '' : ` · missing: ${scrub(bridge.missingBridge)}`} (${bridge.state})`,
    task.task === null
      ? `Task: none, ${scrub(task.missing[0] ?? 'no task evidence')} (${task.state})`
      : `Task: ${scrub(task.task.id)} ${task.task.state} · owner ${scrub(task.task.owner)} · claim ${scrub(task.task.claimReceipt)} (${task.state})`,
    ...(withLast && lastVerified !== null ? [lastVerified] : []),
    ...(withRunning && running !== null ? [running] : []),
    r.overall.state === 'VERIFIED'
      ? 'Evidence only; this reply grants no dispatch.'
      : r.overall.state === 'BLOCKED'
        ? `BLOCKED on: ${missing}`
        : `UNKNOWN: ${missing}`,
  ].join('\n');
  let text = build(true, true, true, true);
  if (text.length > REPLY_MAX) text = build(true, true, true);
  if (text.length > REPLY_MAX) text = build(true, true, false);
  if (text.length > REPLY_MAX) text = build(true, false, false);
  if (text.length > REPLY_MAX) text = build(false, false, false);
  return text.length <= REPLY_MAX ? text : `${text.slice(0, REPLY_MAX - 1)}…`;
}
