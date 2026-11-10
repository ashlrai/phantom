import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../components/primitives/Toast.js';
import { markCheckComplete } from '../../data/auth-store.js';
import { evictAll } from '../../data/cache.js';
import { MockEventSource } from './fixtures.test-support.js';
import { resetDockStore } from './dock/dock-store.js';
import { resetCommandBus } from './shell/command-bus.js';
import { activity, shellFetch } from './shell/shell-fixtures.test-support.js';
import { resetActivityForTest } from './shell/useActivity.js';
import { mockViewport, type ViewportMock } from './shell/viewport.test-support.js';
import { VerseApp } from './VerseApp.js';
import { resetVerseStore } from './verse-store.js';
import { getVerseUiState, reloadVerseUiForTest, resetVerseUi } from './verse-ui-store.js';

// RQ-PHX-UISTOREOLDSTATE82 — the render half of the 3.29.15 → 3.30.x upgrade:
// test/verse-ui-store-upgrade-82.test.ts proves the blob loads to valid state;
// these prove VerseApp opens on it — saved, migrated, or default surface.

const FIXTURE_DIR = resolve(process.cwd(), 'test/fixtures/verse-ui-store');
const readFixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(FIXTURE_DIR, name), 'utf8')) as Record<string, unknown>;

function seedFixture(fixture: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(fixture)) {
    localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
}

const surface = (id: string) => document.querySelector<HTMLElement>(`[data-surface="${id}"]`);

// Resolve the lazy section chunks up front like VerseApp.test.tsx does: cold
// transforms outlast findBy's window when the file runs alone.
beforeAll(async () => {
  const { SECTION_MODULES } = await import('./shell/section-modules.js');
  await Promise.all(Object.values(SECTION_MODULES).map((load) => load()));
}, 60_000);

let viewport: ViewportMock | null = null;

beforeEach(() => {
  window.history.replaceState(null, '', '/verse/');
  localStorage.clear();
  evictAll();
  resetVerseStore();
  resetVerseUi();
  resetDockStore();
  resetCommandBus();
  resetActivityForTest();
  markCheckComplete(true);
  MockEventSource.reset();
  vi.stubGlobal('EventSource', MockEventSource);
  vi.stubGlobal('fetch', shellFetch(activity()).fetch);
  viewport = mockViewport(1440);
});

afterEach(() => {
  viewport?.restore();
  viewport = null;
  markCheckComplete(false);
  resetActivityForTest();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

async function mount(): Promise<void> {
  render(<ToastProvider><VerseApp /></ToastProvider>);
  await screen.findByRole('navigation', { name: 'Phantom sections' });
}

describe('VerseApp on a 3.29.15 persisted blob', () => {
  it('opens on the saved Chat surface', async () => {
    seedFixture(readFixture('v3-29-15.json'));
    reloadVerseUiForTest();
    expect(getVerseUiState().section).toBe('chat');

    await mount();
    await waitFor(() => expect(surface('chat')!.childElementCount).toBeGreaterThan(0), { timeout: 20_000 });
    expect(surface('chat')).not.toHaveAttribute('hidden');
  }, 60_000);

  it('opens on Fleet when the saved section id was removed', async () => {
    seedFixture(readFixture('v3-29-15-corrupt.json'));
    reloadVerseUiForTest();
    expect(getVerseUiState().section).toBe('fleet');

    await mount();
    await waitFor(() => expect(surface('fleet')!.childElementCount).toBeGreaterThan(0), { timeout: 20_000 });
  }, 60_000);

  it('opens on the default surface when nothing is stored', async () => {
    reloadVerseUiForTest();
    expect(getVerseUiState().section).toBe('live');
    await mount();
    await waitFor(() => expect(surface('live')!.childElementCount).toBeGreaterThan(0), { timeout: 20_000 });
  }, 60_000);
});

describe('appearance state written by 3.29.15', () => {
  async function bootAppearance(): Promise<typeof import('../../data/appearance-store.js')> {
    vi.resetModules();
    return import('../../data/appearance-store.js');
  }

  it('keeps the operator’s choices and defaults the fields 3.29.15 did not have', async () => {
    seedFixture(readFixture('v3-29-15.json'));
    const appearance = await bootAppearance();
    expect(appearance.getAppearance()).toMatchObject({
      theme: 'dark',
      accentH: 210,
      accentS: 80,
      accentL: 55,
      density: 'compact',
      uiScale: 'large',
      displayFont: 'mono',
      radius: 'soft',
      motion: 'full',
      layout: 'auto',
    });
  });

  it('resets wrong-type values and clamps out-of-range numbers', async () => {
    seedFixture(readFixture('v3-29-15-corrupt.json'));
    const appearance = await bootAppearance();
    expect(appearance.getAppearance()).toMatchObject({
      theme: 'system',
      accentH: 279,
      accentS: 72,
      accentL: 30,
      density: 'comfortable',
      uiScale: 'default',
      displayFont: 'grotesk',
      radius: 'default',
      layout: 'auto',
      motion: 'system',
    });
  });
});
