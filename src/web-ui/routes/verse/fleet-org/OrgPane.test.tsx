import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { fleetOrgMap } from '../../../../core/fleet/org-map.js';
import { fleetOrgTree } from '../../../../core/fleet/org-tree.js';
import type { FleetRunsDirState } from '../../../../core/fleet/runs-dir-state.js';
import type { FleetSessionsV1 } from '../../../../core/fleet/runs-sessions.js';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { OrgPane } from './OrgPane.js';

const props = { visible: true, host: { openPane: vi.fn() } } as unknown as PaneProps;
const AT = new Date().toISOString();
const office = {
  org: { roles: [
    { id: 'leader', title: 'Digital co-founder', owner: 'leader', lane: 'frontier' },
    { id: 'engineering', title: 'Engineering', owner: 'engineering', lane: 'work' },
  ] },
  priorities: [{ rq: 'RQ-A-1', owner: 'engineering', status: 'in_progress', due: null, outcome: null }],
  outbox: [],
};
/** GET /api/verse/fleet/control/map as the server sends it: the graph plus the `phm org` tree. */
function orgMap() {
  const sessions = { generatedAt: AT, sourceState: 'healthy', truncated: false, recent: [], sessions: [
    { job: 'RQ-A', lane: 'claude', repo: 'phantom', model: 'fixture-model', status: 'running', elapsedSeconds: 60, startedAt: AT, live: 'yes' }] } as unknown as FleetSessionsV1;
  const map = fleetOrgMap(null, { sessions });
  const runs = { lastTick: AT, paused: false, events: [], sources: { status: 'healthy' }, lanes: [
    { lane: 'claude', running: 1, target: 8, queued: 0, held: false, heldReason: null }, { lane: 'grok', running: 0, target: 4, queued: 0, held: true, heldReason: 'quota' }] } as unknown as FleetRunsDirState;
  return { ...map, tree: fleetOrgTree(map, { runs }) };
}
const MAP = '/api/verse/fleet/control/map', OFFICE = '/api/verse/leader/office';

function stub(map: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const hit = Object.entries(map).find(([path]) => url.includes(path));
    return hit ? Response.json(hit[1]) : new Response('{}', { status: 404 });
  }));
}
beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('draws the phm org tree first, then the executives from the leader office', async () => {
  stub({ [OFFICE]: office, [MAP]: orgMap() });
  render(<OrgPane {...props} />);
  const tree = await screen.findByRole('region', { name: 'Org tree' });
  expect(within(tree).getByText('Leader (CEO)').parentElement).toHaveTextContent('Directing 1 running job across 1 lane');
  expect(within(tree).getByRole('button', { name: /^claude,/ })).toHaveTextContent('1 of 8 running');
  expect(within(tree).getByRole('button', { name: 'Open job RQ-A' })).toHaveTextContent('Working in phantom');
  expect(within(tree).getByRole('button', { name: /^grok,/ }).closest('li')).toHaveAttribute('data-state', 'held');
  const execs = await screen.findByRole('region', { name: 'Executives' });
  expect(within(execs).getByText('Engineering')).toBeInTheDocument();
  expect(within(execs).getByText('1 active')).toBeInTheDocument();
  expect(within(execs).getByText('Working')).toBeInTheDocument();
  // The leader appears once, in the tree; the office's leader role is not drawn again as a card.
  expect(within(execs).queryByText('Digital co-founder')).toBeNull();
});

it('falls back to initials for an executive without an image', async () => {
  stub({ [OFFICE]: office, [MAP]: orgMap() });
  render(<OrgPane {...props} />);
  const execs = await screen.findByRole('region', { name: 'Executives' });
  expect(execs.querySelector('img')).toBeNull();
  expect(within(execs).getByText('EN')).toBeInTheDocument();
});

it('names what is down instead of rendering an empty organization', async () => {
  stub({});
  render(<OrgPane {...props} />);
  expect(await screen.findByText('The organization could not be read.')).toBeInTheDocument();
  expect(await screen.findByText('Executives not reported right now.')).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Org tree' })).toBeNull();
});

it('rebuilds the tree from the graph when the server sends a tree this build cannot read', async () => {
  stub({ [MAP]: { ...orgMap(), tree: { schema: 'fleet.org.v1', version: 99, lanes: [], leader: { dispatcher: {} }, sources: {} } } });
  render(<OrgPane {...props} />);
  const tree = await screen.findByRole('region', { name: 'Org tree' });
  expect(within(tree).getByRole('button', { name: 'Open job RQ-A' })).toBeInTheDocument();
  expect(within(tree).getByRole('button', { name: /^claude,/ })).toHaveTextContent('unknown of unknown running');
});

it('Machines row: one chip per computer with its free slots (two machines, one offline)', async () => {
  const row = (name: string, o: Record<string, unknown>) => ({ name, isSelf: false, stateCode: 'ready', state: 'ready for work', freeMemoryBytes: 'unknown', cpuHeadroomPercent: 'unknown', lanes: ['claude'], jobsRunning: [], freeSlots: 2, ...o });
  stub({ '/runtime-identity/nodes': { nodes: [row('mac-one', { isSelf: true }), row('mac-two', { stateCode: 'offline', state: 'offline since 10:42', freeSlots: 'unknown' })], reasons: [] }, [MAP]: orgMap(), [OFFICE]: { value: office } });
  render(<OrgPane {...props} />);
  const machines = within(await screen.findByRole('region', { name: 'Machines' }));
  expect(await machines.findByText(/mac-one/)).toBeTruthy();
  expect(machines.getAllByRole('listitem').map(li => li.textContent)).toEqual(['mac-one (this Mac) · 2 free', 'mac-two · offline']);
});

it('Machines row says "Only this Mac." with one computer', async () => {
  stub({ '/runtime-identity/nodes': { nodes: [{ name: 'mac-one', isSelf: true, stateCode: 'ready', state: 'ready for work', freeSlots: 1 }], reasons: [] }, [MAP]: orgMap(), [OFFICE]: { value: office } });
  render(<OrgPane {...props} />);
  expect(await within(await screen.findByRole('region', { name: 'Machines' })).findByText('Only this Mac.')).toBeTruthy();
});

it('shows the Leader chip with the model and warns above 95%', async () => {
  const state = (used: number) => ({ v: 1, timeline: [], actions: [], hitRate: {}, seat: { ok: true, line: 'x',
    chip: { model: 'Opus 5.5', lane: 'claude', used_pct: used, reset_at: '2026-11-21T00:00:00Z', warn: used > 95 } } });
  stub({ '/api/verse/leader': state(40), [MAP]: orgMap() });
  render(<OrgPane {...props} />);
  expect(await screen.findByRole('status', { name: 'Leader' })).toHaveTextContent('Leader: Opus 5.5 on claude · 40% used');
  expect(screen.getByRole('status', { name: 'Leader' })).not.toHaveTextContent('nearly full');
  cleanup(); evictAll();
  stub({ '/api/verse/leader': state(99), [MAP]: orgMap() });
  render(<OrgPane {...props} />);
  expect(await screen.findByRole('status', { name: 'Leader' })).toHaveTextContent('plan nearly full, resets 2026-11-21T00:00:00Z');
});

it('shows the Leader chip as unknown when the leader read is down', async () => {
  stub({ [MAP]: orgMap() });
  render(<OrgPane {...props} />);
  expect(await screen.findByRole('status', { name: 'Leader' })).toHaveTextContent('Leader: unknown');
});

it('shows a Team row with each teammate and the pools they bring', async () => {
  stub({ '/api/verse/team/people': { schema: 'phantom.team.v1', version: 1, team: 'default', orgState: 'absent', people: [
    { id: 'person:sam', displayName: 'Sam', role: 'founder', identities: [], lanes: ['claude'], seats: ['sam-agent'], status: 'pending', poolSharePct: 30 }] }, [MAP]: orgMap(), [OFFICE]: { value: office } });
  render(<OrgPane {...props} />);
  const row = await screen.findByRole('region', { name: 'Team' });
  expect(await within(row).findByText('Sam')).toBeInTheDocument();
  expect(row).toHaveTextContent('pools: claude · 30% share');
});
