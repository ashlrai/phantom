import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { FleetQueueV1 } from '../ops/ops-queue-model.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetQueuePane } from './FleetQueuePane.js';

const queue: FleetQueueV1 = {
  v: 1, generatedAt: '2026-10-31T00:00:00Z', sources: { ready: 'healthy', skips: 'healthy' },
  total: 31, ready: 30, parked: 1, malformed: 0, skipsLast24h: 0,
  byLane: [{ lane: 'codex-personal', ready: 29, parked: 0 }, { lane: 'devin', ready: 1, parked: 1 }],
  groups: [], skips: [],
};
const snapshot = { lanes: [
  { lane: 'codex-personal', running: 24, target: 24, held: false },
  { lane: 'devin', running: 0, target: 4, held: true },
] };
beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows each matching lane’s drain status', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('/fleet/runs') ? snapshot : queue)));
  render(<FleetQueuePane {...{ visible: true } as PaneProps} />);
  const personal = (await screen.findByText('codex-personal: 29 ready · 0 parked')).closest('li')!;
  const devin = screen.getByText('devin: 1 ready · 1 parked').closest('li')!;
  expect(await within(personal).findByTestId('lane-drain')).toHaveTextContent('saturated · 0 free');
  expect(within(devin).getByTestId('lane-drain')).toHaveTextContent('held · nothing drains');
});

it('shows no drain text until a snapshot arrives and omits unmatched lanes', async () => {
  let resolveSnapshot!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('/fleet/runs')
    ? new Promise<Response>((resolve) => { resolveSnapshot = resolve; }) : Promise.resolve(Response.json(queue))));
  render(<FleetQueuePane {...{ visible: true } as PaneProps} />);
  await screen.findByText('devin: 1 ready · 1 parked');
  expect(screen.queryByTestId('lane-drain')).not.toBeInTheDocument();
  resolveSnapshot(Response.json({ lanes: [snapshot.lanes[1]] }));
  expect(await screen.findByText('held · nothing drains')).toBeInTheDocument();
  expect(screen.getAllByTestId('lane-drain')).toHaveLength(1);
});
