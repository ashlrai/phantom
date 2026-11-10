/**
 * routes/verse/layout-mode.ts — "wide" or "narrow", from the operator's Layout
 * preference (Settings ▸ Appearance) and the window width.
 *
 * `resolveLayout` is pure. `useLayoutMode` is its React binding for the shell.
 * The preference arrives as an attribute on <html> (`data-layout-pref`), the
 * same channel every other appearance value uses, so this stays out of the
 * first-paint closure that the full appearance store (Settings-only) is kept
 * from, and a change applies live without a store subscription.
 */
import { useEffect, useState } from 'react';

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

function readLayout(): ResolvedLayout {
  if (typeof document === 'undefined' || typeof window === 'undefined') return 'wide';
  const attr = document.documentElement.getAttribute(LAYOUT_PREF_ATTR);
  return resolveLayout(isLayoutPreference(attr) ? attr : 'auto', window.innerWidth);
}

/**
 * The resolved layout. A resize is coalesced to one read per animation frame
 * (a single width read, no writes in between, so dragging the window edge
 * never forces layout twice); the state only changes when the answer does, so
 * a drag inside one class re-renders nothing.
 */
export function useLayoutMode(): ResolvedLayout {
  const [layout, setLayout] = useState<ResolvedLayout>(readLayout);
  useEffect(() => {
    let frame = 0;
    const sync = () => {
      frame = 0;
      setLayout(readLayout());
    };
    const onResize = () => {
      if (!frame) frame = requestAnimationFrame(sync);
    };
    const observer = new MutationObserver(() => setLayout(readLayout()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: [LAYOUT_PREF_ATTR] });
    window.addEventListener('resize', onResize, { passive: true });
    setLayout(readLayout());
    return () => {
      window.removeEventListener('resize', onResize);
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  return layout;
}
