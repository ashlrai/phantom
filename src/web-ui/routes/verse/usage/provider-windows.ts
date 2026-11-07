/**
 * routes/verse/usage/provider-windows.ts — which provider-reported quota
 * windows the console may show, and the one fact it states when a provider
 * retired a window.
 *
 * Anthropic removed the 5-hour (session) limit on Claude subscription plans:
 * the weekly windows are the whole story for a Claude seat. The wire may
 * still carry a `five_hour` window — older collectors, cached shared
 * evidence, a server that predates the change — so every reader filters its
 * windows through `visibleWindows` rather than trusting the payload, and
 * `windowNote` says once per seat why only the weekly window appears.
 *
 * Other providers are untouched: a Codex account keeps its 5-hour window.
 *
 * Pure: no React, no I/O.
 */

/**
 * The ids the retired Claude session window arrives under — `five_hour` is
 * the canonical one (possibly provider-prefixed, the way `claude_five_hour`
 * or a doubled `claude_claude_five_hour` reaches the seat record), `five-hour`
 * and `5h` are the spellings older payloads used.
 */
const SESSION_WINDOW = /^(?:(?:claude|anthropic)_)*(?:five_hour|five-hour|5h)$/;

/**
 * Provider ids that mean "Claude on an Anthropic subscription". The
 * `/api/verse/accounts` payload and the seat roster spell it `claude`;
 * `anthropic` is accepted because the vendor's own name travels on some
 * resource records. `claude-api` is deliberately NOT one — metered API
 * billing is a different product with its own limits.
 */
export function isClaudeProvider(provider: string): boolean {
  const p = provider.trim().toLowerCase();
  return p === 'claude' || p === 'anthropic';
}

/**
 * The windows a seat or account may show: for a Claude provider, every
 * window except the retired session one; for any other provider, the list as
 * reported. Always a new array — callers keep their own ordering.
 */
export function visibleWindows<T extends { id: string }>(provider: string, windows: readonly T[]): T[] {
  if (!isClaudeProvider(provider)) return [...windows];
  return windows.filter((w) => !SESSION_WINDOW.test(w.id));
}

/**
 * The one-line note a Claude seat carries where its session window used to
 * be, or null for a provider that never had the limit lifted.
 */
export function windowNote(provider: string): string | null {
  return isClaudeProvider(provider)
    ? 'Anthropic removed the 5-hour limit on this plan. Only the weekly window applies.'
    : null;
}
