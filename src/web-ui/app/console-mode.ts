/** Scope is selected by a dedicated server-owned path, never a query argument. */
export function isUniverseConsolePath(pathname = window.location.pathname): boolean {
  return pathname === '/universe/' || pathname === '/universe';
}

export function isResourceConsolePath(pathname = window.location.pathname): boolean {
  return pathname === '/resources/' || pathname === '/resources';
}

/** Ashlr Verse: the interactive chat console (src/web-ui/routes/verse). */
export function isVerseConsolePath(pathname = window.location.pathname): boolean {
  return pathname === '/verse/' || pathname === '/verse';
}

/**
 * Verse on a phone (src/web-ui/routes/verse/mobile). The trailing slash is
 * canonical: the service worker's scope is `/verse/m/`, and a scope only
 * covers paths that START with it, so `/verse/m` is moved to `/verse/m/` on
 * load (VerseMobileApp) to be controlled offline.
 */
export const VERSE_MOBILE_PATH = '/verse/m/';

export function isVerseMobilePath(pathname = window.location.pathname): boolean {
  return pathname === '/verse/m/' || pathname === '/verse/m';
}

/** No scoped console subscribes to the general Hub observer channel — Verse
 * opens its own per-session streams (routes/verse/verse-events.ts). */
export function isScopedConsolePath(pathname = window.location.pathname): boolean {
  return isUniverseConsolePath(pathname) || isResourceConsolePath(pathname) || isVerseConsolePath(pathname) || isVerseMobilePath(pathname);
}

// ---------------------------------------------------------------------------
// Which Verse a device gets: the workbench or the phone app
// ---------------------------------------------------------------------------

/**
 * The device's own choice, set from the phone app's More screen ("Use the
 * desktop layout"). Layout state only — never a secret — which is why it may
 * live in localStorage like the theme does.
 */
export const VERSE_LAYOUT_STORAGE_KEY = 'ashlr.verse.layout.v1';
export type VerseLayoutPreference = 'auto' | 'desktop' | 'mobile';

export function readVerseLayoutPreference(): VerseLayoutPreference {
  try {
    const raw = window.localStorage.getItem(VERSE_LAYOUT_STORAGE_KEY);
    return raw === 'desktop' || raw === 'mobile' ? raw : 'auto';
  } catch {
    return 'auto';
  }
}

export function writeVerseLayoutPreference(pref: VerseLayoutPreference): void {
  try {
    if (pref === 'auto') window.localStorage.removeItem(VERSE_LAYOUT_STORAGE_KEY);
    else window.localStorage.setItem(VERSE_LAYOUT_STORAGE_KEY, pref);
  } catch {
    /* storage unavailable: the choice lasts this page only */
  }
}

/**
 * A phone: a coarse pointer on a narrow screen, portrait (< 768 wide) or
 * landscape (< 500 tall). Both halves, so a narrow desktop window (fine
 * pointer) keeps the workbench, and so does a tablet in either orientation
 * (the workbench has its own medium layout for it).
 */
export const VERSE_MOBILE_MEDIA_QUERY = '(pointer: coarse) and (max-width: 767.98px), (pointer: coarse) and (max-height: 499.98px)';

/**
 * Whether /verse should open as the phone app on this device. Never inside
 * the desktop wrapper (it hands the page its tokens before anything runs:
 * that page IS the Mac). An explicit choice beats the media query.
 */
export function prefersVerseMobile(win: Window = window): boolean {
  if (win.__ASHLR_TOKENS__ !== undefined) return false;
  const pref = readVerseLayoutPreference();
  if (pref !== 'auto') return pref === 'mobile';
  if (typeof win.matchMedia !== 'function') return false;
  return win.matchMedia(VERSE_MOBILE_MEDIA_QUERY).matches;
}

/**
 * On `/verse` from a phone: become `/verse/m/` in place — no reload, no
 * second request, the same read session. Returns true when it switched. The
 * workbench's hash deep links name desktop surfaces, so they are dropped.
 */
export function autoSelectVerseMobile(win: Window = window): boolean {
  if (!isVerseConsolePath(win.location.pathname) || !prefersVerseMobile(win)) return false;
  try {
    win.history.replaceState(win.history.state, '', VERSE_MOBILE_PATH);
  } catch {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Console layout: the one set of width breakpoints every shell shares
// ---------------------------------------------------------------------------

/**
 * The width classes for the console shell (the Hub app and the scoped
 * consoles). These are pure widths, unlike VERSE_MOBILE_MEDIA_QUERY: a
 * narrowed desktop window should still collapse to the compact layout.
 *
 *   compact  < 720   phone: chrome stacks into a top strip, one column
 *   regular  720–1919  laptop: sidebar plus the panel column
 *   wide     ≥ 1920  external monitor: content centers and spreads
 *
 * CSS modules cannot read these numbers — media queries take literal
 * pixels — so `syncConsoleLayout` resolves them through matchMedia and
 * stamps the class on `<html>` as `data-console-layout`, which is what the
 * stylesheets key off (`:root[data-console-layout='compact']`).
 */
export const CONSOLE_LAYOUT_BREAKPOINTS = Object.freeze({
  /** Below this width: the compact (phone) layout. */
  compact: 720,
  /** At or above this width: the wide-monitor layout. */
  wide: 1920,
});

export type ConsoleLayout = 'compact' | 'regular' | 'wide';

export const CONSOLE_LAYOUT_QUERIES = Object.freeze({
  compact: `(max-width: ${CONSOLE_LAYOUT_BREAKPOINTS.compact - 0.02}px)`,
  wide: `(min-width: ${CONSOLE_LAYOUT_BREAKPOINTS.wide}px)`,
});

/** The class a width falls in (pure; for layout math and tests). */
export function consoleLayoutForWidth(width: number): ConsoleLayout {
  if (width < CONSOLE_LAYOUT_BREAKPOINTS.compact) return 'compact';
  if (width < CONSOLE_LAYOUT_BREAKPOINTS.wide) return 'regular';
  return 'wide';
}

function readConsoleLayout(win: Window): ConsoleLayout {
  if (typeof win.matchMedia === 'function') {
    if (win.matchMedia(CONSOLE_LAYOUT_QUERIES.compact).matches) return 'compact';
    return win.matchMedia(CONSOLE_LAYOUT_QUERIES.wide).matches ? 'wide' : 'regular';
  }
  // Old webviews without matchMedia: the window's own width.
  return win.innerWidth ? consoleLayoutForWidth(win.innerWidth) : 'regular';
}

/**
 * Stamp the current class on `data-console-layout` and keep it true across
 * resizes. Called once by main.tsx before the picked app renders, so every
 * console surface shares the same breakpoints without importing matchMedia.
 * Returns an unsubscribe function.
 */
export function syncConsoleLayout(
  target: HTMLElement = document.documentElement,
  win: Window = window,
): () => void {
  const apply = () => {
    target.dataset.consoleLayout = readConsoleLayout(win);
  };
  apply();
  if (typeof win.matchMedia !== 'function') {
    win.addEventListener('resize', apply);
    return () => win.removeEventListener('resize', apply);
  }
  const lists = [win.matchMedia(CONSOLE_LAYOUT_QUERIES.compact), win.matchMedia(CONSOLE_LAYOUT_QUERIES.wide)];
  for (const list of lists) list.addEventListener('change', apply);
  return () => {
    for (const list of lists) list.removeEventListener('change', apply);
  };
}
