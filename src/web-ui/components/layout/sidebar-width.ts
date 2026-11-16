/**
 * components/layout/sidebar-width.ts — user-resizable width of the shell
 * sidebar. Persisted per-browser in localStorage (no settings store exists
 * for shell chrome; the Verse route keeps its own, separate width in
 * verse-ui-store). Range is 200–480px: below 200 the "soon" chips and the
 * group labels wrap, above 480 the sidebar starts eating the 720px regular
 * breakpoint (docs/CONSOLE-LAYOUT.md) and leaves <main> under 240px.
 */
import { useCallback, useState } from 'react';

export const SIDEBAR_WIDTH = { min: 200, max: 480, def: 240 } as const;
export const SIDEBAR_STEP = 16;
export const SIDEBAR_STEP_COARSE = 48;
export const SIDEBAR_WIDTH_KEY = 'phantom.shell.sidebarWidth';

export function clampSidebarWidth(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return SIDEBAR_WIDTH.def;
  return Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, Math.round(n)));
}

function load(): number {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_KEY);
    return raw === null ? SIDEBAR_WIDTH.def : clampSidebarWidth(raw);
  } catch {
    return SIDEBAR_WIDTH.def;
  }
}

function save(width: number): void {
  try {
    if (width === SIDEBAR_WIDTH.def) window.localStorage.removeItem(SIDEBAR_WIDTH_KEY);
    else window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
  } catch {
    /* private mode / quota: the width still applies for this session */
  }
}

export function useSidebarWidth() {
  const [width, setWidthState] = useState(load);
  const setWidth = useCallback((next: number) => {
    const clamped = clampSidebarWidth(next);
    setWidthState(clamped);
    save(clamped);
  }, []);
  const reset = useCallback(() => setWidth(SIDEBAR_WIDTH.def), [setWidth]);
  return { width, setWidth, reset };
}
