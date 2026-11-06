import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetSteeringPane } from './FleetSteeringPane.js';

beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows prompt citations under the matching order with a linked PR chip', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === '/api/verse/fleet/runs') return Response.json({
      sources: { runsDir: 'healthy', inbox: 'healthy' },
      inbox: [{ at: '2026-10-31 00:13', source: 'Phantom desktop', text: 'Act on this fake order' }],
      events: [],
    });
    if (path === '/api/verse/ops/leader-journal') return Response.json({
      v: 1, generatedAt: '2026-10-31T00:15:00Z',
      sources: { planLog: 'healthy', ingestLog: 'healthy', ingested: 'healthy', orchestration: 'healthy' },
      notes: [], passes: [], ingest: [], ingested: [], rejectedLastHour: null,
    });
    if (path === '/api/verse/leader/orders') return Response.json({
      v: 1, generatedAt: '2026-10-31T00:15:00Z',
      sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' },
      orders: [{ at: '2026-10-31 00:13', source: 'Phantom desktop', key: '10-31 00:13', jobs: [
        { id: 'RQ-FAKE-RUNNING', lane: null, state: 'launched', url: null },
        { id: 'RQ-FAKE-PR', lane: null, state: 'published', prNumber: 2001, url: 'https://github.com/example/fake/pull/2001' },
      ] }],
    });
    throw new Error(`Unexpected test request: ${path}`);
  }));
  render(<FleetSteeringPane {...({ visible: true } as PaneProps)} />);
  expect(await screen.findByText(/2 jobs cite this order/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'PR #2001' })).toHaveAttribute('href', 'https://github.com/example/fake/pull/2001');
  expect(screen.getByRole('button', { name: 'Open log for RQ-FAKE-RUNNING' })).toBeInTheDocument();
  expect(screen.getByText('running')).toBeInTheDocument();
});
