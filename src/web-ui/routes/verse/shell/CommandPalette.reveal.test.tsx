import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken, markCheckComplete } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { openDockPane } from '../dock/dock-store.js';
import { MockEventSource } from '../fixtures.test-support.js';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { useVerseUi } from '../useVerseUi.js';
import { getVerseUiState, openVerseOverlay, resetVerseUi, setVerseSection } from '../verse-ui-store.js';
import { CommandPalette } from './CommandPalette.js';
import { isFocusMode, setFocusMode } from './focus-mode.js';
import { activity, shellFetch } from './shell-fixtures.test-support.js';
import { resetActivityForTest } from './useActivity.js';

vi.mock('../voice/VoiceInput.js', () => ({ default: () => null }));
vi.mock('../panes/index.js', () => ({}));
vi.mock('../panes/pane-registry.js', () => ({ usePanes: () => [
  { id: 'fleet-lanes', title: 'Lanes' },
] }));
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
  setVerseSection('fleet'); setFocusMode(true);
  fleetReads = 0;
  const net = shellFetch(activity());
  const snapshot = { ...fleetRunsFixture(), claudeLane: null,
    workers: [{ job: 'RQ-PHX-FOO', repo: 'phantom', lane: 'codex-personal', tier: 'mid', ageSeconds: 720 }],
    publishesLastHour: [],
  };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith('/api/verse/fleet/runs')) { fleetReads++; return new Response(JSON.stringify(snapshot)); }
    return net.fetch(input, init);
  }));
  resetActivityForTest(path => net.fetch(path).then((r: Response) => r.json()));
  MockEventSource.reset(); vi.stubGlobal('EventSource', MockEventSource); markCheckComplete(true);
});
afterEach(() => {
  act(() => markCheckComplete(false)); setFocusMode(false); resetActivityForTest(); vi.unstubAllGlobals();
});
async function openPalette() {
  act(() => openVerseOverlay('palette'));
  const input = await screen.findByRole('combobox', { name: 'Search commands' });
  await waitFor(() => expect(fleetReads).toBeGreaterThan(0));
  return input;
}

it.each(['Enter', 'click'])('reveals Lanes from Fleet with %s', async (method) => {
  const user = userEvent.setup({ delay: null }); render(<Harness />);
  await user.type(await openPalette(), 'Open pane: Lanes');
  const option = await screen.findByRole('option', { name: /Open pane: Lanes/ });
  if (method === 'Enter') await user.keyboard('{Enter}');
  else await user.click(option);
  expect(getVerseUiState().section).toBe('chat');
  expect(isFocusMode()).toBe(false);
  expect(openDockPane).toHaveBeenCalledExactlyOnceWith('fleet-lanes');
});

it.each(['Enter', 'click'])('reveals the selected worker log from Fleet with %s', async (method) => {
  const user = userEvent.setup({ delay: null }); render(<Harness />);
  await user.type(await openPalette(), '@RQ-PHX-FOO');
  const option = await screen.findByRole('option', { name: /^RQ-PHX-FOO/ });
  if (method === 'Enter') await user.keyboard('{Enter}');
  else await user.click(option);
  expect(getVerseUiState().section).toBe('chat');
  expect(isFocusMode()).toBe(false);
  expect(openDockPane).toHaveBeenCalledExactlyOnceWith('worker-log');
  expect(requestWorkerLogJob).toHaveBeenCalledExactlyOnceWith('RQ-PHX-FOO');
});
