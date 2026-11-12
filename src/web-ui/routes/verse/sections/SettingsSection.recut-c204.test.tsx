/**
 * routes/verse/sections/SettingsSection.recut-c204.test.tsx —
 * RQ-PHX-RECUTDESKS0C204 coverage of the ui-settings recut (PR #5231): the
 * Settings column itself now mounts the file-backed panels — Layout (widths
 * and visibility, mirrored into ~/.ashlr/ui.json by data/ui-settings-sync.ts)
 * and Config file (the raw document the operator or an agent edits).
 *
 * Asserts the user-visible wiring, not the panels in isolation: the headings
 * appear inside the rendered section, the resources-width slider writes the
 * shell store through setVerseResourcesWidth, and the Config file panel
 * exposes the file path and "Reload from file". On master none of these
 * panels exist, so every case fails there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { evictAll } from '../../../data/cache.js';
import { resetAppearance } from '../../../data/appearance-store.js';
import { clearMutationToken } from '../../../data/auth-store.js';
import { getVerseUiState, resetVerseUi, VERSE_RESOURCES } from '../verse-ui-store.js';
import { SettingsSection } from './SettingsSection.js';

function renderSettings() {
  return render(
    <ToastProvider>
      <SettingsSection />
    </ToastProvider>,
  );
}

describe('SettingsSection — ui-settings recut (c204)', () => {
  beforeEach(() => {
    evictAll();
    localStorage.clear();
    resetAppearance();
    resetVerseUi();
    clearMutationToken();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearMutationToken();
    localStorage.clear();
    resetAppearance();
    resetVerseUi();
  });

  it('mounts the Layout and Config file panels in the Settings column', () => {
    renderSettings();
    expect(screen.getByRole('heading', { name: 'Layout' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Config file' })).toBeInTheDocument();
  });

  it('the Layout panel writes the resources width to the shell store', () => {
    renderSettings();
    const layoutPanel = screen.getByRole('heading', { name: 'Layout' }).closest('section');
    expect(layoutPanel).not.toBeNull();
    // Sidebar width is the first slider, Resources width the second.
    const sliders = within(layoutPanel as HTMLElement).getAllByRole('slider');
    expect(sliders).toHaveLength(2);
    fireEvent.change(sliders[1]!, { target: { value: '400' } });
    expect(getVerseUiState().resourcesWidth).toBe(400);
    fireEvent.change(sliders[1]!, { target: { value: String(VERSE_RESOURCES.max + 500) } });
    expect(getVerseUiState().resourcesWidth).toBe(VERSE_RESOURCES.max);
  });

  it('the Config file panel names the file and offers a reload action', () => {
    renderSettings();
    const configPanel = screen.getByRole('heading', { name: 'Config file' }).closest('section');
    expect(configPanel).not.toBeNull();
    expect(within(configPanel as HTMLElement).getByText('~/.ashlr/ui.json')).toBeInTheDocument();
    expect(
      within(configPanel as HTMLElement).getByRole('button', { name: 'Reload from file' }),
    ).toBeInTheDocument();
  });
});
