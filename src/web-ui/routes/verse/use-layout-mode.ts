/** routes/verse/use-layout-mode.ts — the shell's React binding for layout-mode.ts. */
import { useEffect, useState } from 'react';
import { LAYOUT_PREF_ATTR, isLayoutPreference, resolveLayout, type ResolvedLayout } from './layout-mode.js';

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
