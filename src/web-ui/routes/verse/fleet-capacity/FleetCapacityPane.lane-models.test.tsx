import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { FleetCapacityPane } from './FleetCapacityPane.js';
import { laneModelsQuery } from './lane-models-query.js';
const at = new Date().toISOString();
const history = { v: 1, generatedAt: at, from: at, to: at, sourceState: 'healthy', dropped: 0,
  samples: [{ at, workers: 1, leaders: 1, paused: false, lanes: ['codex-personal', 'devin'].map(lane => ({ lane, running: 1, target: 2, queued: 0, held: false })) }] };
function stub(mismatch = false, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).endsWith('/lane-models')) return Response.json({ v: 1, generatedAt: at, source: 'ok', reason: null, launches: 1,
      lanes: [{ lane: 'codex-personal', family: 'codex', tiers: [{ tier: 'mid', model: 'fake-model', via: null }], mismatch,
        lastLaunch: { lane: 'codex-personal', tier: 'mid', model: mismatch ? 'fake-old' : 'fake-model', at } }] }, { status });
    if (String(url).includes('/runs-history?')) return Response.json(history);
    return Response.json({}, { status: 404 });
  }));
}
beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('renders lane models only under the matching capacity card, without a warning', async () => {
  stub(); render(<FleetCapacityPane visible />);
  expect(await screen.findByTestId('lane-models')).toHaveTextContent('mid fake-model · last launch mid → fake-model');
  const other = screen.getByRole('button', { name: 'Open devin in Lanes' }).closest('li')!;
  expect(within(other).queryByTestId('lane-models')).not.toBeInTheDocument();
  expect(screen.queryByText(/last launch used/)).not.toBeInTheDocument();
});
it('renders a mismatch warning', async () => {
  stub(true); render(<FleetCapacityPane visible />);
  expect(await screen.findByText('last launch used fake-old, table says fake-model')).toHaveAttribute('data-tone', 'warning');
});
it('treats a 404 as null and preserves capacity history', async () => {
  stub(false, 404);
  expect(await laneModelsQuery.fetch()).toBeNull();
  render(<FleetCapacityPane visible />);
  await screen.findByRole('button', { name: 'Open codex-personal in Lanes' });
  expect(screen.queryByTestId('lane-models')).not.toBeInTheDocument();
  expect(screen.queryByText(/^Models:/)).not.toBeInTheDocument();
});
it('does not fetch lane models while inactive', () => {
  stub(); render(<FleetCapacityPane visible={false} />);
  expect(fetch).not.toHaveBeenCalled();
});
