import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { ApiError } from '../../../data/client.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';
import { setLaneWriting } from '../fleet-lanes/LaneTargetStepper.js';
import { postLaneTarget } from '../ops/lane-targets-queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetSupplyPane } from './FleetSupplyPane.js';

vi.mock('../ops/lane-targets-queries.js', async importOriginal => ({
  ...await importOriginal<typeof import('../ops/lane-targets-queries.js')>(),
  postLaneTarget: vi.fn(),
}));

const now = Date.parse('2026-10-31T23:30:00Z');
const laneName = 'codex-personal';
const response = {
  v: 1 as const, generatedAt: new Date(now).toISOString(), sourceState: 'healthy' as const,
  lanes: [{ lane: laneName, target: 4, floor: 0, ceiling: 64, held: false, heldReason: null, heldUntil: null, lastChange: null, changedBy: null }],
};
const props = { visible: true } as PaneProps;

function setup(held = false, ledgerHeld = held) {
  const runs = { lanes: [{ lane: laneName, running: 2, target: 2, queued: 0, held, heldReason: null }], workers: [], drop: { pending: [] }, sources: { runsDir: 'healthy' } };
  const ledger = {
    v: 1, generatedAt: new Date(now).toISOString(), sources: { status: 'healthy', apiSpend: 'healthy' }, asOf: null, apiSpend: null,
    lanes: [{ lane: laneName, running: 2, target: 2, held: ledgerHeld, window: 'weekly', usedPct: 68, creditsRemaining: null,
      resetAt: new Date(now + 8 * 3_600_000).toISOString(), burnPctPerHour: 2, tokensPerHour6h: null, projectedExhaustion: null, source: null }],
  };
  const fetcher = vi.fn(async (url: string) => Response.json(url.includes('/fleet/runs') ? runs : url.includes('/control/lanes') ? response : ledger));
  vi.stubGlobal('fetch', fetcher);
  render(<FleetSupplyPane {...props} />);
  return fetcher;
}

beforeEach(() => { evictAll(); vi.spyOn(Date, 'now').mockReturnValue(now); });
afterEach(() => { cleanup(); setLaneWriting(false); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('sets the suggested target once and refreshes all three readings', async () => {
  vi.mocked(postLaneTarget).mockResolvedValue(response);
  const fetcher = setup();
  const button = await screen.findByRole('button', { name: 'Set target 4' });
  expect(within(button.closest('li')!).getByText(/needs target 4 \(now 2, 1%\/h per worker\)/)).toBeInTheDocument();
  fireEvent.click(button);
  fireEvent.click(button);
  expect(postLaneTarget).toHaveBeenCalledTimes(1);
  expect(postLaneTarget).toHaveBeenCalledWith(laneName, 4);
  expect(await screen.findByRole('status')).toHaveTextContent('Lane codex-personal: target 4 saved');
  await waitFor(() => expect(fetcher.mock.calls.map(([url]) => url)).toEqual(expect.arrayContaining([
    '/api/verse/fleet/runs', '/api/verse/leader/resources', '/api/verse/fleet/control/lanes',
  ])));
  expect(fetcher.mock.calls.filter(([url]) => url.includes('/fleet/runs'))).toHaveLength(2);
  expect(fetcher.mock.calls.filter(([url]) => url.includes('/leader/resources'))).toHaveLength(2);
});

it('shows the lock error inline', async () => {
  const error = new VerseControlLockedError();
  vi.mocked(postLaneTarget).mockRejectedValue(error);
  setup();
  fireEvent.click(await screen.findByRole('button', { name: 'Set target 4' }));
  expect(await screen.findByRole('status')).toHaveTextContent(error.message);
});

it('shows other write failures inline', async () => {
  vi.mocked(postLaneTarget).mockRejectedValue(new ApiError('Rejected', 409, '/fake', 'Save failed'));
  setup();
  fireEvent.click(await screen.findByRole('button', { name: 'Set target 4' }));
  expect(await screen.findByRole('status')).toHaveTextContent('Save failed');
});

it('reports the target returned by the server', async () => {
  vi.mocked(postLaneTarget).mockResolvedValue({ ...response, lanes: [{ ...response.lanes[0]!, target: 3 }] });
  setup();
  fireEvent.click(await screen.findByRole('button', { name: 'Set target 4' }));
  expect(await screen.findByRole('status')).toHaveTextContent('Lane codex-personal: target 3 saved');
});

it.each([[true, false], [false, true]])('requires release when either reading says the lane is held', async (held, ledgerHeld) => {
  setup(held, ledgerHeld);
  expect(await screen.findByText(/held: release first/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Set target/ })).not.toBeInTheDocument();
});
