import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetDecisionsPane } from './FleetDecisionsPane.js';
import { fixture } from './fixtures.js';

beforeEach(() => { evictAll(); vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows a merged PR only on the launched decision', async () => {
  const data = fixture();
  data.decisions[0].title = 'Ship RQ-PHX-EXAMPLE1';
  data.decisions[2].title = 'Skip RQ-PHX-EXAMPLE1';
  const runs: FleetRuns = {
    v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
    lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
    lanes: [], workers: [], leaders: [], orchestratorAgents: null, publishesLastHour: [],
    mergesLastHour: { count: 1, items: [{ repo: 'example/repo', number: 42, title: 'bridge: RQ-PHX-EXAMPLE1' }] },
    events: [], codexPersonal: null, inbox: [], drop: null,
  };
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => Response.json(String(url).endsWith('/fleet/runs') ? runs : data)));
  const props = { visible: true, host: { openPane: vi.fn() } } as unknown as PaneProps;
  render(<FleetDecisionsPane {...props} />);

  const link = await screen.findByRole('link', { name: 'PR #42 · merged' });
  expect(link).toHaveAttribute('href', 'https://github.com/example/repo/pull/42');
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', 'noreferrer');
  const rows = within(screen.getByRole('list', { name: 'Decisions' })).getAllByRole('listitem');
  const skipped = rows.find(row => row.textContent?.includes('Skip RQ-PHX-EXAMPLE1'))!;
  expect(within(skipped).queryByTestId('decision-pr')).toBeNull();
  expect(screen.getAllByTestId('decision-pr')).toHaveLength(1);
});
