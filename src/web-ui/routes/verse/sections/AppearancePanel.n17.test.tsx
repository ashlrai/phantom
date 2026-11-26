/**
 * AppearancePanel.n17 — Settings > Appearance as an operator meets it: one
 * obvious control per `phm settings appearance` key (theme, accent, density,
 * font size), plain-word labels, every pick applied to the live document with
 * no save step, and the accent's slider escape hatch tucked behind a
 * "Custom color" disclosure that only starts open for a custom accent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsSection } from './SettingsSection.js';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { evictAll } from '../../../data/cache.js';
import { getAppearance, resetAppearance, setAppearance } from '../../../data/appearance-store.js';
import { ACCENT_PRESETS } from '../../../data/appearance-presets.js';
import { setSettingsView } from './settings-groups.js';

const root = () => document.documentElement;

function renderSettings() {
  return render(
    <ToastProvider>
      <SettingsSection />
    </ToastProvider>,
  );
}

const customDisclosure = () => screen.getByText('Custom color').closest('details')!;

// The long page these suites assert is the "All settings" view.
beforeEach(() => { setSettingsView('all'); });

describe('Settings > Appearance (n17)', () => {
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

  it('shows one plain-word control per CLI key', () => {
    renderSettings();
    const theme = screen.getByRole('radiogroup', { name: 'Theme' });
    expect(within(theme).getAllByRole('radio').map((r) => r.textContent?.trim())).toEqual(['System', 'Light', 'Dark', 'High contrast']);
    const accent = screen.getByRole('radiogroup', { name: 'Accent' });
    expect(within(accent).getAllByRole('radio')).toHaveLength(ACCENT_PRESETS.length);
    expect(within(screen.getByRole('radiogroup', { name: 'Density' })).getAllByRole('radio').map((r) => r.textContent?.trim())).toEqual(['Comfortable', 'Compact']);
    expect(within(screen.getByRole('radiogroup', { name: 'Display size' })).getAllByRole('radio').map((r) => r.textContent?.trim())).toEqual(['Default', 'Large', 'Extra large']);
    // The old jargon row is gone: the sliders live inside the Accent row.
    expect(screen.queryByText('Accent channels')).toBeNull();
  });

  it('applies each pick to the live document with no save or reload', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(within(screen.getByRole('radiogroup', { name: 'Theme' })).getByRole('radio', { name: /Dark/ }));
    expect(root().getAttribute('data-theme')).toBe('dark');
    await user.click(within(screen.getByRole('radiogroup', { name: 'Theme' })).getByRole('radio', { name: /System/ }));
    expect(root().hasAttribute('data-theme')).toBe(false); // the OS media query decides

    await user.click(within(screen.getByRole('radiogroup', { name: 'Density' })).getByRole('radio', { name: 'Compact' }));
    expect(getAppearance().density).toBe('compact');
    await user.click(within(screen.getByRole('radiogroup', { name: 'Display size' })).getByRole('radio', { name: 'Large' }));
    expect(root().getAttribute('data-ui-scale')).toBe('large');

    const rose = ACCENT_PRESETS.at(-1)!;
    await user.click(screen.getByRole('radio', { name: rose.label }));
    expect(root().style.getPropertyValue('--accent-h')).toBe(String(rose.h));
  });

  it('keeps Custom color closed for a preset accent and open for a custom one', () => {
    const { unmount } = renderSettings();
    expect(customDisclosure().open).toBe(false);
    unmount();

    setAppearance({ accentH: 17, accentS: 61, accentL: 47 });
    renderSettings();
    expect(customDisclosure().open).toBe(true);
    expect(screen.getByRole('slider', { name: 'Hue' })).toHaveValue('17');
  });

  it('does not snap shut while dragging back onto a preset', () => {
    renderSettings();
    const details = customDisclosure();
    details.open = true;
    fireEvent(details, new Event('toggle'));

    const first = ACCENT_PRESETS[0]!;
    fireEvent.change(screen.getByRole('slider', { name: 'Hue' }), { target: { value: String((first.h + 7) % 360) } });
    fireEvent.change(screen.getByRole('slider', { name: 'Hue' }), { target: { value: String(first.h) } });
    expect(getAppearance().accentH).toBe(first.h);
    expect(customDisclosure().open).toBe(true);
  });
});
