/** Pure, bounded peer-budget evidence for the owner's Slack thread. */
import { stripVTControlCharacters } from 'node:util';
import type { PeerLedgerReport } from '../agentnet/peer-ledger.js';
import { sanitizeIdentityText } from './runtime-identity.js';

const MAX_REPLY = 1500;
const FOOTER = 'Read-only ledger metadata; grants no send or dispatch authority.';
const TRUNCATED = '(list truncated)';

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

export function formatPeerLedgerReply(report: PeerLedgerReport): string {
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
    for (const pair of pairs.slice(0, 5)) {
      lines.push(`${scrub(pair.fromAgent)} → ${scrub(pair.target)}: ${pair.inWindow}/${report.pairLimit} in window, ${pair.remaining} left${pair.remaining === 0 ? ' RATE-LIMITED' : ''}${retrySuffix(pair)}`);
    }
    for (const origin of report.origins.filter(o => o.nearCap)) {
      lines.push(`Near hop cap: ${scrub(origin.origin)} at hop ${origin.maxHop}/${report.maxHops}`);
    }
    truncated = pairs.length > 5 || report.truncated.pairs || report.truncated.origins;
  }
  const body = lines.join('\n');
  if (!truncated && body.length + 1 + FOOTER.length <= MAX_REPLY) return `${body}\n${FOOTER}`;
  const tail = `\n${TRUNCATED}\n${FOOTER}`;
  const budget = MAX_REPLY - tail.length;
  return `${body.length > budget ? `${body.slice(0, budget - 1)}…` : body}${tail}`;
}
