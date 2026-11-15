/** Pure, bounded peer-budget evidence for the owner's Slack thread. */
import { stripVTControlCharacters } from 'node:util';
import type { PeerLedgerReport, PeerLedgerSelection } from '../agentnet/peer-ledger.js';
import { sanitizeIdentityText } from './runtime-identity.js';

const MAX_REPLY = 1500;
const FOOTER = 'Read-only ledger metadata; grants no send or dispatch authority.';
const PAIR_FOOTER = 'Read-only ledger metadata; grants no send, claim or dispatch authority.';
const TRUNCATED = '(list truncated)';
const NO_EVIDENCE = 'no live evidence — absence is not a quota reading';

function scrub(text: string): string {
  return sanitizeIdentityText(stripVTControlCharacters(text)
    .replace(/\p{Cc}/gu, ' ').replace(/\/(?:Users|home)\/[^/\s;,)]+/g, '~'), '').trim();
}

// A blocked pair may carry a projected throttle-release instant; anything that is
// not a finite parseable timestamp is reported as unknown, never invented.
function retrySuffix(pair: PeerLedgerReport['pairs'][number]): string {
  if (pair.remaining !== 0) return '';
  const at = typeof pair.retryAt === 'string' ? Date.parse(pair.retryAt) : Number.NaN;
  return Number.isFinite(at) ? ` · projected retry ${new Date(at).toISOString()}` : ' · projected retry unknown';
}

function pairLine(pair: PeerLedgerReport['pairs'][number], pairLimit: number): string {
  return `${scrub(pair.fromAgent)} → ${scrub(pair.target)}: ${pair.inWindow}/${pairLimit} in window, ${pair.remaining} left${pair.remaining === 0 ? ' RATE-LIMITED' : ''}${retrySuffix(pair)}`;
}

function capReply(body: string, footer: string, truncated: boolean): string {
  if (!truncated && body.length + 1 + footer.length <= MAX_REPLY) return `${body}\n${footer}`;
  const tail = `\n${TRUNCATED}\n${footer}`;
  const budget = MAX_REPLY - tail.length;
  return `${body.length > budget ? `${body.slice(0, budget - 1)}…` : body}${tail}`;
}

/** One exact pair: only the selected evidence, never the aggregate top rows.
 * An absent pair says there is no live evidence — it is never a quota reading —
 * and an unavailable ledger stays unknown rather than claiming anything. */
function formatSelectedPairReply(report: PeerLedgerReport, sel: PeerLedgerSelection): string {
  const who = `${scrub(sel.fromAgent)} → ${scrub(sel.target)}`;
  const lines: string[] = [];
  if (report.status === 'unavailable') {
    lines.push(`Peers pair ${who} unknown: ${scrub(report.reason ?? 'peer ledger unavailable')}`);
  } else {
    lines.push(`Peers pair ${who} (as of ${scrub(report.asOf)}): ${report.status}${report.reason ? ` — ${scrub(report.reason)}` : ''}`,
      `Live rows ${report.liveRows}/${report.capacity} · pair limit ${report.pairLimit} per ${report.windowMs / 1000}s · hop cap ${report.maxHops}`);
    if (sel.match === 'none' || report.pairs.length === 0) {
      lines.push(`${who}: ${NO_EVIDENCE}`);
    } else {
      for (const pair of report.pairs) lines.push(pairLine(pair, report.pairLimit));
    }
  }
  return capReply(lines.join('\n'), PAIR_FOOTER, false);
}

export function formatPeerLedgerReply(report: PeerLedgerReport): string {
  if (report.selection !== undefined) return formatSelectedPairReply(report, report.selection);
  const lines: string[] = [];
  let truncated = false;
  if (report.status === 'unavailable') {
    lines.push(`Peers unknown: ${scrub(report.reason ?? 'peer ledger unavailable')}`);
  } else {
    lines.push(`Peers (as of ${scrub(report.asOf)}): ${report.status}${report.reason ? ` — ${scrub(report.reason)}` : ''}`,
      `Live rows ${report.liveRows}/${report.capacity} · pair limit ${report.pairLimit} per ${report.windowMs / 1000}s · hop cap ${report.maxHops}`);
    if (report.status === 'empty') lines.push('No peer messages in the last 24h.');
    const pairs = [...report.pairs].sort((a, b) => a.remaining - b.remaining
      || a.fromAgent.localeCompare(b.fromAgent) || a.target.localeCompare(b.target));
    for (const pair of pairs.slice(0, 5)) lines.push(pairLine(pair, report.pairLimit));
    for (const origin of report.origins.filter(o => o.nearCap)) {
      lines.push(`Near hop cap: ${scrub(origin.origin)} at hop ${origin.maxHop}/${report.maxHops}`);
    }
    truncated = pairs.length > 5 || report.truncated.pairs || report.truncated.origins;
  }
  return capReply(lines.join('\n'), FOOTER, truncated);
}
