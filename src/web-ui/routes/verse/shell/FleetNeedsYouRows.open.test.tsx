import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { FleetNeedsYouRows } from './FleetNeedsYouRows.js';
import { openDockPane } from '../dock/dock-store.js';
import { closeVerseOverlay, setVerseSection } from '../verse-ui-store.js';
import { setFocusMode } from './focus-mode.js';
import { TERMINAL_PANE_ID } from '../terminal/terminal.pane.js';
const state = vi.hoisted(() => ({ data: undefined as unknown }));
vi.mock('../../../data/hooks.js', () => ({
  useQuery: (query: { key: string }) => ({ data: query.key === 'verse-usage-resets' ? null : state.data, status: 'success' }),
  useRefetch: () => () => {}, useRefresh: () => () => {},
}));
vi.mock('../dock/dock-store.js', () => ({ openDockPane: vi.fn(), requestTerminal: vi.fn() }));
vi.mock('../verse-ui-store.js', () => ({ closeVerseOverlay: vi.fn(), setVerseSection: vi.fn() }));
vi.mock('./focus-mode.js', () => ({ setFocusMode: vi.fn() }));
vi.mock('./section-visibility.js', () => ({ usePollWhileVisible: vi.fn() }));
vi.mock('../terminal/terminal.pane.js', () => ({ TERMINAL_PANE_ID: 'terminal' }));
const NOW = Date.parse('2026-10-31T12:00:00Z');

/** A healthy snapshot: dispatcher ticking, a lane working, sources green. */
function snapshot(over: Partial<FleetRuns> = {}): FleetRuns {
  return {
    v: 1,
    generatedAt: '2026-10-31T12:00:00Z',
    sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
    lastTick: '2026-10-31T11:59:00Z',
    paused: false,
    memFreePct: 50,
    diskFreeGb: 80,
    switches: [],
    claudeLane: null,
    lanes: [{ lane: 'codex-cmp', running: 1, target: 2, queued: 0, held: false, heldReason: null, tokensLastHour: 100, merged24h: 2, mergeRate24h: 50 }],
    workers: [{ job: 'job-one', repo: 'phantom', lane: 'codex-cmp', tier: 'frontier', ageSeconds: 120 }],
    leaders: [{ label: 'leader', ageSeconds: 30 }],
    orchestratorAgents: 1,
    publishesLastHour: [],
    mergesLastHour: { count: 1, items: [{ repo: 'phantom', number: 12, title: 'Fleet view' }] },
    events: [{ at: '2026-10-31T11:55:00Z', kind: 'worker-start', text: 'started job-one' }],
    codexPersonal: null,
    inbox: [],
    drop: null,
    ...over,
  };
}

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });
function show(data: FleetRuns) {
  state.data = { ...data, kind: 'notInBuild' };
  vi.stubGlobal('fetch', vi.fn());
  render(<FleetNeedsYouRows split="fleet" nowMs={NOW} onResult={() => {}} />);
}
it('closes the overlay and reveals Lanes from outside Chat', () => {
  show(snapshot({ lanes: [{ ...snapshot().lanes[0]!, held: true }] }));
  fireEvent.click(screen.getByRole('button', { name: 'Open Lanes' }));
  expect(closeVerseOverlay).toHaveBeenCalledOnce();
  expect(setFocusMode).toHaveBeenCalledWith(false);
  expect(setVerseSection).toHaveBeenCalledWith('chat');
  expect(openDockPane).toHaveBeenCalledWith('fleet-lanes');
  expect(vi.mocked(closeVerseOverlay).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(openDockPane).mock.invocationCallOrder[0]!);
});
it('copies the exact fix and opens Terminal without sending a request', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  show(snapshot({ claudeLane: 'down' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open Terminal' }));
  await screen.findByRole('button', { name: 'Open Terminal · command copied' });
  expect(writeText).toHaveBeenCalledWith('~/.ashlr-runs/bin/fix-claude-lane.sh');
  expect(openDockPane).toHaveBeenCalledWith(TERMINAL_PANE_ID);
  expect(closeVerseOverlay).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
});
it('keeps a failed clipboard command visible for manual copying', async () => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
  show(snapshot({ claudeLane: 'down' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open Terminal' }));
  await waitFor(() => expect(screen.getByText('Copy command: ~/.ashlr-runs/bin/fix-claude-lane.sh')).toBeVisible());
  expect(closeVerseOverlay).not.toHaveBeenCalled();
  expect(openDockPane).toHaveBeenCalledWith(TERMINAL_PANE_ID);
  expect(fetch).not.toHaveBeenCalled();
});
