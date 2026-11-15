/** Exact, short owner "owners" asks: answered in-thread with sanitized surface
 * ownership evidence (surface-owners-reply.ts) instead of routing prose.
 * Anything longer, such as "owners of PR #12 please", stays a request for the
 * Leader. Normalization matches review-ask.ts: trim, ≤40 chars,
 * case-insensitive, curly apostrophes folded, trailing ?.! dropped. */
export function isOwnersAsk(text: string): boolean {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed.length > 40) return false;
  const ask = trimmed.toLowerCase().replace(/’/g, "'").replace(/[?.!]+$/, '').trim();
  return /^(?:owners?|who owns|who owns the bridge|bridge owners?|who(?:'s| is) the owner)$/.test(ask);
}
