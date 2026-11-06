/**
 * Which app a path gets, and when /verse becomes the phone app on its own:
 * a coarse pointer on a narrow screen, never inside the desktop wrapper, and
 * never against the device's explicit choice.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  autoSelectVerseMobile,
  CONSOLE_LAYOUT_BREAKPOINTS,
  CONSOLE_LAYOUT_QUERIES,
  consoleLayoutForWidth,
  isScopedConsolePath,
  isVerseConsolePath,
  isVerseMobilePath,
  prefersVerseMobile,
  readVerseLayoutPreference,
  syncConsoleLayout,
  VERSE_LAYOUT_STORAGE_KEY,
  VERSE_MOBILE_MEDIA_QUERY,
  VERSE_MOBILE_PATH,
  writeVerseLayoutPreference,
} from './console-mode.js';

function fakeWindow(opts: { pathname?: string; phone?: boolean; tokens?: boolean; matchMedia?: boolean } = {}) {
  const queries: string[] = [];
  let pathname = opts.pathname ?? '/verse';
  const win = {
    location: {
      get pathname() {
        return pathname;
      },
    },
    history: {
      state: { keep: 1 },
      replaceState: (_s: unknown, _t: string, url: string) => {
        pathname = url;
      },
    },
    ...(opts.tokens ? { __ASHLR_TOKENS__: { readToken: 'x' } } : {}),
    ...(opts.matchMedia === false
      ? {}
      : {
          matchMedia: (q: string) => {
            queries.push(q);
            return { matches: opts.phone === true } as MediaQueryList;
          },
        }),
  } as unknown as Window;
  return { win, queries, path: () => pathname };
}

afterEach(() => {
  window.localStorage.clear();
});

describe('console paths', () => {
  it('knows the phone path with and without its slash, and keeps it scoped', () => {
    expect(VERSE_MOBILE_PATH).toBe('/verse/m/');
    expect(isVerseMobilePath('/verse/m')).toBe(true);
    expect(isVerseMobilePath('/verse/m/')).toBe(true);
    expect(isVerseMobilePath('/verse/mobile')).toBe(false);
    expect(isVerseMobilePath('/verse')).toBe(false);
    expect(isVerseConsolePath('/verse/m/')).toBe(false);
    // The phone app never opens the general Hub observer channel either.
    expect(isScopedConsolePath('/verse/m/')).toBe(true);
    expect(isScopedConsolePath('/')).toBe(false);
  });
});

describe('prefersVerseMobile', () => {
  it('asks for a coarse pointer on a narrow screen (portrait or landscape)', () => {
    const phone = fakeWindow({ phone: true });
    expect(prefersVerseMobile(phone.win)).toBe(true);
    expect(phone.queries).toEqual([VERSE_MOBILE_MEDIA_QUERY]);
    expect(VERSE_MOBILE_MEDIA_QUERY).toContain('(pointer: coarse)');
    expect(VERSE_MOBILE_MEDIA_QUERY).toContain('max-width: 767.98px');
    expect(VERSE_MOBILE_MEDIA_QUERY).toContain('max-height: 499.98px');
    expect(prefersVerseMobile(fakeWindow({ phone: false }).win)).toBe(false);
  });

  it('never inside the desktop wrapper, which hands the page its tokens', () => {
    expect(prefersVerseMobile(fakeWindow({ phone: true, tokens: true }).win)).toBe(false);
  });

  it('without matchMedia (old webviews) stays on the workbench', () => {
    expect(prefersVerseMobile(fakeWindow({ matchMedia: false }).win)).toBe(false);
  });

  it("follows the device's explicit choice over the media query", () => {
    writeVerseLayoutPreference('desktop');
    expect(readVerseLayoutPreference()).toBe('desktop');
    expect(prefersVerseMobile(fakeWindow({ phone: true }).win)).toBe(false);
    writeVerseLayoutPreference('mobile');
    expect(prefersVerseMobile(fakeWindow({ phone: false }).win)).toBe(true);
    writeVerseLayoutPreference('auto');
    expect(window.localStorage.getItem(VERSE_LAYOUT_STORAGE_KEY)).toBeNull();
    expect(readVerseLayoutPreference()).toBe('auto');
  });

  it('ignores a garbage stored value', () => {
    window.localStorage.setItem(VERSE_LAYOUT_STORAGE_KEY, 'tablet');
    expect(readVerseLayoutPreference()).toBe('auto');
  });
});

/** A window whose matchMedia reports the layout held by `state.current`, with change events the test fires. */
function layoutWindow(state: { current: 'compact' | 'regular' | 'wide' }, opts: { innerWidth?: number; matchMedia?: boolean } = {}) {
  const listeners = new Set<() => void>();
  const win = {
    innerWidth: opts.innerWidth ?? 0,
    addEventListener: (_t: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_t: string, cb: () => void) => listeners.delete(cb),
    ...(opts.matchMedia === false
      ? {}
      : {
          matchMedia: (query: string) => ({
            get matches() {
              return query === CONSOLE_LAYOUT_QUERIES.compact
                ? state.current === 'compact'
                : query === CONSOLE_LAYOUT_QUERIES.wide
                  ? state.current === 'wide'
                  : false;
            },
            addEventListener: (_t: string, cb: () => void) => listeners.add(cb),
            removeEventListener: (_t: string, cb: () => void) => listeners.delete(cb),
          }),
        }),
  } as unknown as Window;
  return { win, fireChange: () => [...listeners].forEach((cb) => cb()) };
}

function layoutTarget() {
  return { dataset: {} as Record<string, string> } as unknown as HTMLElement;
}

describe('console layout breakpoints', () => {
  it('classifies phone, laptop and wide-monitor widths at the shared edges', () => {
    expect(CONSOLE_LAYOUT_BREAKPOINTS).toEqual({ compact: 720, wide: 1920 });
    expect(CONSOLE_LAYOUT_QUERIES.compact).toBe('(max-width: 719.98px)');
    expect(CONSOLE_LAYOUT_QUERIES.wide).toBe('(min-width: 1920px)');
    expect(consoleLayoutForWidth(390)).toBe('compact');
    expect(consoleLayoutForWidth(719.98)).toBe('compact');
    expect(consoleLayoutForWidth(720)).toBe('regular');
    expect(consoleLayoutForWidth(1440)).toBe('regular');
    expect(consoleLayoutForWidth(1919.98)).toBe('regular');
    expect(consoleLayoutForWidth(1920)).toBe('wide');
    expect(consoleLayoutForWidth(2560)).toBe('wide');
  });

  it('stamps data-console-layout from matchMedia and keeps it true across changes', () => {
    const state = { current: 'wide' as 'compact' | 'regular' | 'wide' };
    const { win, fireChange } = layoutWindow(state);
    const target = layoutTarget();
    const stop = syncConsoleLayout(target, win);
    expect(target.dataset.consoleLayout).toBe('wide');
    state.current = 'compact';
    fireChange();
    expect(target.dataset.consoleLayout).toBe('compact');
    stop();
    state.current = 'regular';
    fireChange();
    expect(target.dataset.consoleLayout).toBe('compact');
  });

  it('falls back to the window width when matchMedia is missing', () => {
    const state = { current: 'regular' as const };
    const target = layoutTarget();
    const stop = syncConsoleLayout(target, layoutWindow(state, { innerWidth: 390, matchMedia: false }).win);
    expect(target.dataset.consoleLayout).toBe('compact');
    stop();
  });
});

describe('autoSelectVerseMobile', () => {
  it('moves /verse to /verse/m/ in place on a phone, keeping history state', () => {
    const phone = fakeWindow({ pathname: '/verse', phone: true });
    expect(autoSelectVerseMobile(phone.win)).toBe(true);
    expect(phone.path()).toBe('/verse/m/');
  });

  it('leaves a desktop, the wrapper and other paths alone', () => {
    const desktop = fakeWindow({ pathname: '/verse/', phone: false });
    expect(autoSelectVerseMobile(desktop.win)).toBe(false);
    expect(desktop.path()).toBe('/verse/');
    const wrapper = fakeWindow({ pathname: '/verse', phone: true, tokens: true });
    expect(autoSelectVerseMobile(wrapper.win)).toBe(false);
    const universe = fakeWindow({ pathname: '/universe', phone: true });
    expect(autoSelectVerseMobile(universe.win)).toBe(false);
    expect(universe.path()).toBe('/universe');
  });
});
