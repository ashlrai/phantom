import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken, markCheckComplete } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { MockEventSource } from '../fixtures.test-support.js';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import { openDockPane } from '../dock/dock-store.js';
import { useVerseUi } from '../useVerseUi.js';
import { closeVerseOverlay, getVerseUiState, openVerseOverlay, resetVerseUi } from '../verse-ui-store.js';
import { CommandPalette } from './CommandPalette.js';
import { activity, shellFetch } from './shell-fixtures.test-support.js';
import { resetActivityForTest } from './useActivity.js';

// Voice input is unrelated to worker navigation and has its own integration tests.
vi.mock('../voice/VoiceInput.js', () => ({ default: () => null }));
vi.mock('../panes/index.js', () => ({}));
vi.mock('../panes/pane-registry.js', () => ({ usePanes: () => [
  { id: 'worker-log', title: 'Worker log' }, { id: 'lanes', title: 'Lanes' },
] }));
vi.mock('../dock/dock-store.js', async importOriginal => ({ ...await importOriginal<typeof import('../dock/dock-store.js')>(), openDockPane: vi.fn() }));

function Harness() {
  const ui = useVerseUi();
  return ui.overlay === 'palette' ? <CommandPalette /> : null;
}
let fleetReads = 0;
let snapshot: ReturnType<typeof fleetRunsFixture>;
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear(); evictAll(); resetVerseUi(); clearMutationToken();
  fleetReads = 0;
  const net = shellFetch(activity());
  snapshot = { ...fleetRunsFixture(), claudeLane: null,
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
it.each([['worker log', 'worker-log'], ['lanes', 'lanes']])('opens %s with Enter, records it and closes', async (query, paneId) => {
  const user = userEvent.setup({ delay: null }); render(<Harness />);
  await user.type(await openPalette(), query);
  await user.keyboard('{Enter}');
  expect(openDockPane).toHaveBeenCalledWith(paneId);
  expect(getVerseUiState().recentActions).toContain(`pane.${paneId}`);
  expect(getVerseUiState().overlay).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
});
