import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { openDockPane } from '../dock/dock-store.js';
import { openInterjectDialog } from '../fleet/interject-dialog-store.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { getVerseUiState, openVerseNeedsYou, resetVerseUi } from '../verse-ui-store.js';
import { FleetNeedsYouRows } from './FleetNeedsYouRows.js';

vi.mock('../dock/dock-store.js', async importOriginal => ({
  ...await importOriginal<typeof import('../dock/dock-store.js')>(),
  openDockPane: vi.fn(),
}));
vi.mock('../fleet/interject-dialog-store.js', () => ({ openInterjectDialog: vi.fn() }));

const NOW = Date.parse('2026-10-31T12:00:00Z');
const snapshot: FleetRuns = {
  v: 1,
  generatedAt: '2026-10-31T12:00:00Z',
  sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: '2026-10-31T11:59:00Z',
  paused: false, memFreePct: 50, diskFreeGb: 80, switches: [],
  claudeLane: 'down token rejected',
  lanes: [{ lane: 'codex-cmp', running: 1, target: 2, queued: 0, held: false, heldReason: null, tokensLastHour: 100, merged24h: 2, mergeRate24h: 50 }],
  workers: [{ job: 'job-one', repo: 'phantom', lane: 'codex-cmp', tier: 'frontier', ageSeconds: 120 }],
  leaders: [{ label: 'leader', ageSeconds: 30 }], orchestratorAgents: 1, publishesLastHour: [],
  mergesLastHour: { count: 1, items: [{ repo: 'phantom', number: 12, title: 'Fleet view' }] },
  events: [{ at: '2026-10-31T11:55:00Z', kind: 'worker-start', text: 'started job-one' }],
  codexPersonal: null, inbox: [], drop: null,
};

beforeEach(() => {
  evictAll();
  resetVerseUi();
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === '/api/verse/fleet/runs') {
      return new Response(JSON.stringify(snapshot), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('opens a prefilled interjection without opening the incident target', async () => {
  const user = userEvent.setup();
  const writeText = vi.spyOn(navigator.clipboard, 'writeText');
  act(() => openVerseNeedsYou({ split: 'fleet' }));
  vi.mocked(openInterjectDialog).mockImplementation(() => {
    expect(getVerseUiState().overlay).toBeNull();
  });
  render(<FleetNeedsYouRows split="fleet" nowMs={NOW} onResult={() => {}} />);

  await user.click(await screen.findByRole('button', { name: 'Tell the leaders about The Claude lane is down' }));

  expect(openInterjectDialog).toHaveBeenCalledOnce();
  expect(openInterjectDialog).toHaveBeenCalledWith({ prefill: expect.stringMatching(/^Re "The Claude lane is down"/) });
  expect(openDockPane).not.toHaveBeenCalled();
  expect(writeText).not.toHaveBeenCalled();
});
