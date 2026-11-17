/** Exact, short owner "review" asks: answered in-thread with the live unowned
 * review pick (review-pick.ts + review-pick-reply.ts) — repo, PR, head sha and
 * owner none, or the honest reason there is none. Anything longer, such as
 * "review PR #12 please", stays a request for the Leader. Normalization
 * matches status-ask.ts, recheck-ask.ts and orders-ask.ts: trim, ≤40 chars,
 * case-insensitive, curly apostrophes folded, trailing ?.! dropped. */
export function isReviewAsk(text: string): boolean {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed.length > 40) return false;
  const ask = trimmed.toLowerCase().replace(/’/g, "'").replace(/[?.!]+$/, '').trim();
  return /^(?:review|review pick|unowned review)$/.test(ask);
}
