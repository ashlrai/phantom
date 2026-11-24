/**
 * What a recorded credit balance may draw on the shared usage bar (primitives/WindowBar), and what the open
 * Credit balances disclosure counts. Pure: the cards in CreditPools.tsx render what this decides.
 *
 * The bar's `used` is the share of the recorded grant that was gone when the balance was captured (for a
 * subscription window, the share recorded as used). It comes only from two recorded figures. A balance with no
 * recorded grant has no share, so no bar is drawn and a sentence says why; a balance that is unknown or hidden
 * is a hatched bar, never an empty one. Nothing here adds balances together or turns one unit into another.
 */
import type { ClaudeApiGrantView } from '../../../../core/resources/claude-api-grant-types.js';
import type { CreditPoolRowView } from '../../../../core/resources/credit-pool-types.js';
import { usedPercentText } from '../percent-text.js';

export interface CreditBar {
  /** False when the balance is known and only the grant is missing: no bar is drawn, `line` says why. */
  drawn: boolean;
  /** 0 to 100; null = no reading of the share. */
  used: number | null;
  /** What the bar counts, after the card's name in the meter's label. */
  counts: 'share spent' | 'used';
  /** The bar in words, for the meter's value text. */
  words: string;
  /** The sentence under the bar; null when the figure above it already says the same. */
  line: string | null;
}

/** Share of `total` no longer in `left`, 0 to 100; null when the total is zero or a figure is unusable. */
function spentShare(left: number, total: number): number | null {
  if (!Number.isFinite(left) || !Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.min(100, (1 - left / total) * 100));
}

function spentBar(spent: number | null, known: boolean, grantWord: string, unknownWords: string): CreditBar {
  if (!known) return { drawn: true, used: null, counts: 'share spent', words: unknownWords, line: null };
  if (spent === null) {
    const line = `No ${grantWord} is recorded, so the share spent is unknown.`;
    return { drawn: false, used: null, counts: 'share spent', words: line, line };
  }
  const line = `${usedPercentText(spent)} of the recorded ${grantWord} was gone at capture.`;
  return { drawn: true, used: spent, counts: 'share spent', words: line, line };
}

/** `amountText` is the card's own figure (creditPoolDisplay), reused as the words of a bar with no share. */
export function creditPoolBar(row: CreditPoolRowView, amountText: string): CreditBar {
  const known = row.identityState === 'matched' && row.amount !== null;
  if (row.kind === 'subscription-allowance') {
    return { drawn: true, used: known ? Math.max(0, Math.min(100, Number(row.amount))) : null, counts: 'used', words: amountText, line: null };
  }
  return spentBar(known && row.total !== null ? spentShare(Number(row.amount), Number(row.total)) : null,
    known, row.kind === 'gifted-cloud' ? 'grant' : 'total', amountText);
}

export function apiGrantBar(row: ClaudeApiGrantView): CreditBar {
  const known = row.remainingUsdMicros !== null;
  return spentBar(known && row.totalUsdMicros !== null ? spentShare(Number(row.remainingUsdMicros), Number(row.totalUsdMicros)) : null,
    known, 'grant', 'API promotional balance unknown');
}

/** "3d 4h", "5h 12m", "9m": the length of a gap in milliseconds, whichever way it points. */
export function spanText(ms: number): string {
  const minutes = Math.floor(Math.abs(ms) / 60_000);
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60);
  return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

export interface CreditSummary {
  /** Balances with a figure on screen, of every balance listed. */
  recorded: number;
  listed: number;
  /** The dollar credit whose recorded deadline comes first. A subscription reset is not a credit expiry. */
  next: { title: string; at: string } | null;
}

/** Counts what the open disclosure lists. Balances are never summed: pools and currencies stay separate. */
export function creditSummary(pools: readonly CreditPoolRowView[], grants: readonly ClaudeApiGrantView[], nowMs: number): CreditSummary {
  const deadlines = [
    ...pools.filter(row => row.kind !== 'subscription-allowance' && row.expiryKind === 'fixed' && row.expiresAt !== null)
      .map(row => ({ title: row.kind === 'gifted-cloud' ? 'Cloud gift' : 'Purchased usage credits', at: row.expiresAt! })),
    ...grants.filter(row => row.admissionCutoff !== null).map(row => ({ title: 'Claude API promotion', at: row.admissionCutoff! })),
  ].filter(entry => Date.parse(entry.at) > nowMs).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return {
    recorded: pools.filter(row => row.identityState === 'matched' && row.amount !== null).length
      + grants.filter(row => row.remainingUsdMicros !== null).length,
    listed: pools.length + grants.length,
    next: deadlines[0] ?? null,
  };
}

export function summaryWords(summary: CreditSummary, nowMs: number): string {
  const count = summary.recorded === summary.listed
    ? `${summary.listed} ${summary.listed === 1 ? 'balance' : 'balances'} recorded`
    : `${summary.recorded} of ${summary.listed} balances recorded, ${summary.listed - summary.recorded} without a figure`;
  return summary.next
    ? `${count}. First deadline: ${summary.next.title}, in ${spanText(Date.parse(summary.next.at) - nowMs)}.`
    : `${count}. No credit deadline ahead is recorded.`;
}
