import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken, markCheckComplete } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { MockEventSource } from '../fixtures.test-support.js';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { openDockPane } from '../dock/dock-store.js';
import { useVerseUi } from '../useVerseUi.js';
import { closeVerseOverlay, getVerseUiState, openVerseOverlay, resetVerseUi } from '../verse-ui-store.js';
import { CommandPalette } from './CommandPalette.js';
import { activity, shellFetch } from './shell-fixtures.test-support.js';
import { resetActivityForTest } from './useActivity.js';

// Voice input is unrelated to worker navigation and has its own integration tests.
vi.mock('../voice/VoiceInput.js', () => ({ default: () => null }));
vi.mock('../fleet-job-log/worker-log-selection.js', () => ({ requestWorkerLogJob: vi.fn() }));
vi.mock('../dock/dock-store.js', async importOriginal => ({ ...await importOriginal<typeof import('../dock/dock-store.js')>(), openDockPane: vi.fn() }));

function Harness() {
  const ui = useVerseUi();
  return ui.overlay === 'palette' ? <CommandPalette /> : null;
}
let fleetReads = 0;
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear(); evictAll(); resetVerseUi(); clearMutationToken();
  fleetReads = 0;
  const net = shellFetch(activity());
  const snapshot = { ...fleetRunsFixture(), claudeLane: null,
    workers: [{ job: 'RQ-PHX-FOO', repo: 'phantom', lane: 'codex-personal', tier: 'mid', ageSeconds: 720 }],
    publishesLastHour: [{ job: 'RQ-PHX-FOO', lane: 'codex-personal', url: 'https://github.com/x/y/pull/1719', at: '2026-10-31T12:00:00Z' }],
  };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith('/api/verse/fleet/runs')) { fleetReads++; return new Response(JSON.stringify(snapshot)); }
    return net.fetch(input, init);
  }));
  resetActivityForTest(path => net.fetch(path).then((r: Response) => r.json()));
  MockEventSource.reset(); vi.stubGlobal('EventSource', MockEventSource); markCheckComplete(true);
});
afterEach(() => {
  act(() => markCheckComplete(false)); resetActivityForTest(); vi.unstubAllGlobals();
});
async function openPalette() {
  act(() => openVerseOverlay('palette'));
  const input = await screen.findByRole('combobox', { name: 'Search commands' });
  await waitFor(() => expect(fleetReads).toBeGreaterThan(0));
  return input;
}
it('opens the selected worker live log with Enter, records it and closes', async () => {
  const user = userEvent.setup({ delay: null }); render(<Harness />);
  expect(fleetReads).toBe(0);
  await user.type(await openPalette(), 'rq-p');
  await waitFor(() => expect(screen.getByRole('option', { name: /^RQ-PHX-FOO/ })).toHaveAttribute('aria-selected', 'true'));
  await user.keyboard('{Enter}');
  expect(requestWorkerLogJob).toHaveBeenCalledWith('RQ-PHX-FOO');
  expect(openDockPane).toHaveBeenCalledWith('worker-log');
  expect(getVerseUiState().overlay).toBeNull();
  expect(getVerseUiState().recentActions).toContain('worker.log');
  expect(screen.queryByRole('dialog')).toBeNull();
});
it('reads the fleet afresh when the palette reopens', async () => {
  render(<Harness />);
  await openPalette();
  act(() => closeVerseOverlay());
  await openPalette();
  await waitFor(() => expect(fleetReads).toBe(2));
});
it('opens a published PR safely and records the action', async () => {
  const open = vi.fn(); vi.stubGlobal('open', open);
  const user = userEvent.setup({ delay: null }); render(<Harness />);
  await user.type(await openPalette(), '@pr');
  await screen.findByRole('option', { name: /Open PR #1719/ });
  await user.keyboard('{Enter}');
  expect(open).toHaveBeenCalledWith('https://github.com/x/y/pull/1719', '_blank', 'noopener,noreferrer');
  expect(requestWorkerLogJob).not.toHaveBeenCalled();
  expect(getVerseUiState().recentActions).toContain('worker.pr');
  expect(getVerseUiState().overlay).toBeNull();
});
