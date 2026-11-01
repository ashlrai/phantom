import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../components/primitives/Toast.js';
import { markCheckComplete } from '../../data/auth-store.js';
import { evictAll } from '../../data/cache.js';
import { MockEventSource } from './fixtures.test-support.js';
import { resetDockStore } from './dock/dock-store.js';
import { resetCommandBus } from './shell/command-bus.js';
import { ciFacts } from './shell/ci-needs-you.test-support.js';
import { activity, approvalNeed, shellFetch, vetoNeed } from './shell/shell-fixtures.test-support.js';
import { resetActivityForTest } from './shell/useActivity.js';
import { VerseApp } from './VerseApp.js';
import { resetVerseStore } from './verse-store.js';
import { resetVerseUi } from './verse-ui-store.js';

beforeEach(() => {
  localStorage.clear();
  evictAll();
  resetVerseStore();
  resetVerseUi();
  resetDockStore();
  resetCommandBus();
  resetActivityForTest();
  markCheckComplete(true);
  const net = shellFetch(activity({ needsYou: [approvalNeed('p-1'), vetoNeed()] }));
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === '/api/verse/fleet/ci-runs?hours=24'
      ? Promise.resolve(Response.json({ ...ciFacts, generatedAt: new Date().toISOString() }))
      : net.fetch(input, init)));
  vi.stubGlobal('EventSource', MockEventSource);
});
afterEach(() => { markCheckComplete(false); resetActivityForTest(); vi.unstubAllGlobals(); });

it('adds CI to the rail before the drawer opens', async () => {
  render(<ToastProvider><VerseApp /></ToastProvider>);
  const rail = await screen.findByRole('navigation', { name: 'Phantom sections' });
  expect(await within(rail).findByRole('button', { name: 'Needs you, 3' }, { timeout: 20_000 })).toBeInTheDocument();
}, 60_000);
