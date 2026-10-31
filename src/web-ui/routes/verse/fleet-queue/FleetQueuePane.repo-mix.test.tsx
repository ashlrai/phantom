import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { isFleetQueue, type FleetQueueV1 } from '../ops/ops-queue-model.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetQueuePane } from './FleetQueuePane.js';
import { restockNotice } from './queue-repo-mix.js';

const fixture = (): FleetQueueV1 => ({
  v: 1, generatedAt: '2026-10-31T00:00:00Z', sources: { ready: 'healthy', skips: 'healthy' },
  total: 22, ready: 19, parked: 3, malformed: 0, skipsLast24h: 0,
  byLane: [{ lane: 'codex-personal', ready: 19, parked: 3 }], groups: [], skips: [],
});
beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('renders repo counts and the personal Phantom restock notice', async () => {
  const data = fixture();
  Object.assign(data.byLane[0]!, { phantom: 17, other: 2, otherRepos: ['ashlr-hub', 'verse'] });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));
  render(<FleetQueuePane {...{ visible: true } as PaneProps} />);
  expect(await screen.findByText('codex-personal: 19 ready (17 Phantom · 2 other: ashlr-hub, verse) · 3 parked')).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Only 17 Phantom lines are ready on codex-personal; under 20 the author adds filler on the next restock.');
});

it('preserves old payload text without a restock notice', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture())));
  render(<FleetQueuePane {...{ visible: true } as PaneProps} />);
  expect(await screen.findByText('codex-personal: 19 ready · 3 parked')).toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

it('validates optional mix fields independently and warns only below the personal threshold', () => {
  expect(isFleetQueue(fixture())).toBe(true);
  for (const mix of [{ phantom: '17' }, { phantom: -1 }, { other: 0.5 }, { otherRepos: [1] }]) {
    expect(isFleetQueue({ ...fixture(), byLane: [{ ...fixture().byLane[0], ...mix }] })).toBe(false);
  }
  expect(restockNotice([{ lane: 'codex-personal', phantom: 20 }])).toBeNull();
  expect(restockNotice([{ lane: 'devin', phantom: 0 }])).toBeNull();
  expect(restockNotice([{ lane: 'codex-personal', phantom: 0 }])).toContain('Only 0 Phantom');
});
