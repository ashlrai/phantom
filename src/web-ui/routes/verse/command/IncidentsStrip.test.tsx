import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { evictAll, getQuerySnapshot } from '../../../data/cache.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { IncidentsStrip } from './IncidentsStrip.js';

vi.mock('../shell/run-command.js', () => ({ executeCatalogCommand: vi.fn() }));
import { executeCatalogCommand } from '../shell/run-command.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const fixture: FleetRuns = {
  v: 1, generatedAt: new Date(now).toISOString(), sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: new Date(now).toISOString(), paused: false, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: 'up', lanes: [], workers: [], leaders: [], orchestratorAgents: null,
  publishesLastHour: [], mergesLastHour: { count: 0, items: [] }, events: [{ at: new Date(now).toISOString(), kind: 'START', text: '' }], codexPersonal: null, inbox: [], drop: null,
};
const serve = (data: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn(async () => Response.json(data, { status })));
const row = () => <SectionVisibilityProvider visible><IncidentsStrip now={now} /></SectionVisibilityProvider>;
beforeEach(() => { evictAll(); vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('renders nothing while loading and when the fleet is healthy', async () => {
  serve(fixture);
  const view = render(row());
  expect(view.container).toBeEmptyDOMElement();
  await waitFor(() => expect(getQuerySnapshot<FleetRuns>('verse-fleet-runs').data).toEqual(fixture));
  expect(view.container).toBeEmptyDOMElement();
});
it('renders ranked rows and opens Ops', async () => {
  serve({ ...fixture, claudeLane: 'down: run fix-claude-lane.sh', switches: ['HOLD'] });
  render(row());
  const region = await screen.findByRole('region', { name: 'Incidents' });
  const rows = within(region).getAllByRole('listitem');
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent('Claude lane is down');
  expect(rows[0]).toHaveTextContent('run fix-claude-lane.sh');
  expect(rows[1]).toHaveTextContent('HOLD is on: nothing launches until it is removed.');
  fireEvent.click(within(region).getByRole('button', { name: 'Open Ops' }));
  expect(executeCatalogCommand).toHaveBeenCalledWith('section.ops', { via: 'button' });
});
it('hides an unavailable query', async () => {
  serve({}, 503);
  const view = render(row());
  await waitFor(() => expect(getQuerySnapshot('verse-fleet-runs').status).toBe('error'));
  expect(view.container).toBeEmptyDOMElement();
});
it('shows the stall fix as code', async () => {
  serve({ ...fixture, events: [{ at: new Date(now - 40 * 60_000).toISOString(), kind: 'launch', text: '' }] });
  render(row());
  const region = await screen.findByRole('region', { name: 'Incidents' });
  expect(within(region).getByText(/Run the leader:/).tagName).toBe('CODE');
});
