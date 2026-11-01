import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetDispatchPane } from './FleetDispatchPane.js';
import type { PlannerPlanView } from './planner-plan-queries.js';

const props = { visible: true, roots: ['/workspace'], host: { openTerminal: vi.fn() } } as unknown as PaneProps;
const nowMs = Date.parse('2026-10-31T05:09:00Z');
const plan = (over: Partial<PlannerPlanView>): PlannerPlanView => ({
  v: 1,
  generatedAt: new Date(nowMs).toISOString(),
  path: '~/.ashlr-runs/queue/planner-candidates.json',
  source: 'ok',
  choice: null,
  nextResetAt: null,
  limited: [],
  health: [],
  ...over,
});

function stubFetch(planner: () => Response) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
    String(input).includes('/api/verse/leader/planner/plan') ? planner() : Response.json(fleetRunsFixture({ claudeLane: null }))));
}

beforeEach(() => { evictAll(); vi.spyOn(Date, 'now').mockReturnValue(nowMs); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('shows the next planner pass line at the top of the pane', async () => {
  stubFetch(() => Response.json(plan({
    choice: { provider: 'codex-personal', reason: 'ok' },
    health: [{ provider: 'codex-personal', status: 'ok', failingSince: null, lastGoodPassAt: new Date(nowMs - 12 * 60_000).toISOString(), resetAt: null, reason: null }],
  })));
  render(<FleetDispatchPane {...props} />);
  const line = await screen.findByText('Next planner pass: codex-personal (healthy, last ok 12 min ago).');
  const header = await screen.findByText(/free slots/);
  expect(line.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('alerts why no planner can run when every candidate is limited', async () => {
  stubFetch(() => Response.json(plan({
    limited: [{ provider: 'codex-personal', status: 'usage-limit', until: '2026-11-07T15:16:00-05:00' }, { provider: 'claude-api', status: 'failing', until: null }],
    nextResetAt: '2026-11-07T20:16:00.000Z',
  })));
  render(<FleetDispatchPane {...props} />);
  const line = await screen.findByRole('alert');
  expect(line).toHaveTextContent('No planner can run: codex-personal limited until Nov 7 15:16, claude-api failing. Fix the executor or add a candidate.');
});

it('warns when the candidates file is missing', async () => {
  stubFetch(() => Response.json(plan({ source: 'missing' })));
  render(<FleetDispatchPane {...props} />);
  expect(await screen.findByText('Planner candidates file missing: ~/.ashlr-runs/queue/planner-candidates.json.')).toBeInTheDocument();
});

it('renders no planner line when the route is absent', async () => {
  stubFetch(() => Response.json({}, { status: 404 }));
  render(<FleetDispatchPane {...props} />);
  expect(await screen.findByText(/free slots/)).toBeInTheDocument();
  expect(screen.queryByText(/planner pass|planner candidates|no planner/i)).not.toBeInTheDocument();
});
