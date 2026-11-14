/** Exact, short owner "recheck" asks: answered in-thread with the read-only
 * fleet recheck verdict (fleet-recheck.ts + fleet-recheck-reply.ts). Anything
 * longer, such as "recheck PR #5315 please", stays a request for the Leader.
 * Normalization matches status-ask.ts: trim, ≤40 chars, case-insensitive,
 * curly apostrophes folded and trailing ?.! dropped. */
export function isRecheckAsk(text: string): boolean {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed.length > 40) return false;
  const ask = trimmed.toLowerCase().replace(/’/g, "'").replace(/[?.!]+$/, '').trim();
  return /^(?:\/recheck|recheck|phantom recheck|fleet recheck|recheck runtime|recheck live state|can you reach live state)$/.test(ask);
}
