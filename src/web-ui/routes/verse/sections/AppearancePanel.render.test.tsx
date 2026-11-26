/**
 * AppearancePanel.render — Settings ▸ Appearance rendered the way an operator
 * meets it, in light and in dark, at a desktop width and on a 390 px phone:
 * every control, the live preview and "Reset to defaults" are present, the
 * picked theme is on <html>, and Reset brings everything back in one click.
 *
 * jsdom has no layout engine, so the 390 px case pins the CSS that makes the
 * pane fit (rows stack, segmented controls wrap) rather than measuring pixels;
 * and "follows the theme" is pinned by the pane's stylesheet painting only
 * through tokens, so tokens.css (checked by appearance-contrast-matrix) is the
 * single place a theme changes it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsSection } from './SettingsSection.js';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { evictAll } from '../../../data/cache.js';
import { defaultAppearance, getAppearance, resetAppearance, setAppearance } from '../../../data/appearance-store.js';
import { setSettingsView } from './settings-groups.js';

const root = () => document.documentElement;
const CSS = readFileSync(resolve(__dirname, 'SettingsSection.module.css'), 'utf8');

/** A matchMedia that answers width queries for `width` and says "light OS". */
function viewport(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  vi.stubGlobal('matchMedia', (query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    const min = /min-width:\s*(\d+)px/.exec(query);
    const matches = max ? width <= Number(max[1]) : min ? width >= Number(min[1]) : false;
    return { matches, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false };
  });
}

function renderPane() {
  render(
    <ToastProvider>
      <SettingsSection />
    </ToastProvider>,
  );
  return screen.getByRole('heading', { name: 'Appearance' }).closest('section')!;
}

// The long page these suites assert is the "All settings" view.
beforeEach(() => { setSettingsView('all'); });

describe('Settings ▸ Appearance renders in every theme at every width', () => {
  beforeEach(() => {
    evictAll();
    localStorage.clear();
    resetAppearance();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    resetAppearance();
  });

  for (const theme of ['light', 'dark'] as const) {
    for (const [label, width] of [['desktop', 1280], ['390 px', 390]] as const) {
      it(`${theme} at ${label}: every control, the preview and Reset`, async () => {
        viewport(width);
        setAppearance({ theme, density: 'compact' });
        const pane = renderPane();

        expect(root().getAttribute('data-theme')).toBe(theme);
        for (const name of ['Theme', 'Accent', 'Display size', 'Density']) {
          expect(within(pane).getByRole('radiogroup', { name })).toBeInTheDocument();
        }
        const checked = within(within(pane).getByRole('radiogroup', { name: 'Theme' })).getByRole('radio', { checked: true });
        expect(checked).toHaveTextContent(theme === 'light' ? 'Light' : 'Dark');
        expect(within(pane).getByText('Preview')).toBeInTheDocument();
        expect(within(pane).getByRole('textbox', { name: 'Preview field' })).toBeInTheDocument();

        const reset = within(pane).getByRole('button', { name: 'Reset to defaults' });
        expect(reset).toBeEnabled();
        await userEvent.setup().click(reset);
        expect(getAppearance()).toMatchObject({ theme: 'system', density: defaultAppearance().density });
        expect(root().hasAttribute('data-theme')).toBe(false);
        expect(reset).toBeDisabled();
      });
    }
  }

  it('stacks rows and wraps segmented controls under 720 px, so 390 px never scrolls sideways', () => {
    const narrow = /@media \(max-width: 720px\) \{([\s\S]*?)\n\}/.exec(CSS)?.[1] ?? '';
    expect(narrow).toMatch(/\.row \{\s*grid-template-columns: minmax\(0, 1fr\);/);
    expect(narrow).toMatch(/\.rowControl > \[role='radiogroup'\] \{\s*flex-wrap: wrap;\s*max-width: 100%;/);
  });

  it('paints only through theme tokens, so light, dark and high contrast all reach the pane', () => {
    const literals = CSS.split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => /^(color|background(-color)?|border(-color)?|box-shadow|fill|stroke)\s*:/.test(line))
      .filter(({ line }) => /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(line))
      .map(({ line, n }) => `${n}: ${line}`);
    // The swatch check mark is white blended by `difference` over a FIXED
    // preset color, not over a theme ground, so it is theme-independent.
    expect(literals).toEqual([expect.stringMatching(/: color: #ffffff;$/)]);
  });
});
