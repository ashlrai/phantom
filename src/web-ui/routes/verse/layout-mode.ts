/**
 * routes/verse/layout-mode.ts — "wide" or "narrow", from the operator's Layout
 * preference (Settings ▸ Appearance) and the window width.
 *
 * `resolveLayout` is pure. `useLayoutMode` (use-layout-mode.ts) is its React
 * binding for the shell, kept apart so the entry's appearance boot does not
 * carry a React hook.
 * The preference arrives as an attribute on <html> (`data-layout-pref`), the
 * same channel every other appearance value uses, so this stays out of the
 * first-paint closure that the full appearance store (Settings-only) is kept
 * from, and a change applies live without a store subscription.
 */
export type LayoutPreference = 'auto' | 'wide' | 'narrow';
export type ResolvedLayout = 'wide' | 'narrow';

/** Auto switches to narrow below this window width (a half-screen window on a laptop). */
export const NARROW_BELOW_PX = 960;
export const LAYOUT_PREF_ATTR = 'data-layout-pref';

export function isLayoutPreference(value: unknown): value is LayoutPreference {
  return value === 'auto' || value === 'wide' || value === 'narrow';
}

export function resolveLayout(pref: LayoutPreference, widthPx: number): ResolvedLayout {
  if (pref === 'narrow') return 'narrow';
  if (pref === 'auto' && widthPx < NARROW_BELOW_PX) return 'narrow';
  return 'wide';
}
