import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { SEATS_FIXTURE } from '../../../data/agent-roster.fixtures.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { OrgPane } from './OrgPane.js';

const props = { visible: true, host: { openPane: vi.fn() } } as unknown as PaneProps;
const office = {
  org: { roles: [
    { id: 'leader', title: 'Digital co-founder', owner: 'leader', lane: 'frontier' },
    { id: 'engineering', title: 'Engineering', owner: 'engineering', lane: 'work' },
  ] },
  priorities: [{ rq: 'RQ-A-1', owner: 'engineering', status: 'in_progress', due: null, outcome: null }],
  outbox: [],
};
const runs = { lanes: [{ lane: 'claude', running: 1, target: 8, queued: 0, held: false, heldReason: null }, { lane: 'grok', running: 0, target: 4, queued: 0, held: true, heldReason: 'quota' }] };
const roster = { schema: 'agent-roster.v1', claims: { source: 'claim-store', items: [{ owner: 'claude', completed: false }] } };

function stub(map: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const hit = Object.entries(map).find(([path]) => url.includes(path));
    return hit ? Response.json(hit[1]) : new Response('{}', { status: 404 });
  }));
}
beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('renders the leader, executives and teammates from live feeds', async () => {
  stub({ '/api/verse/leader/office': office, '/api/verse/fleet/runs': runs, '/api/verse/fleet/agent-roster': roster, '/api/verse/seats': { seats: SEATS_FIXTURE } });
  render(<OrgPane {...props} />);
  const leader = await screen.findByRole('region', { name: 'Leader' });
  expect(within(leader).getByText('Digital co-founder')).toBeInTheDocument();
  expect(within(leader).getByText('Working')).toBeInTheDocument();
  const execs = screen.getByRole('region', { name: 'Executives' });
  expect(within(execs).getByText('Engineering')).toBeInTheDocument();
  expect(within(execs).getByText('1 active')).toBeInTheDocument();
  const team = screen.getByRole('region', { name: 'Teammates' });
  const claude = within(team).getByText('Claude').closest('li')!;
  expect(within(claude).getByText('Opus 5.5')).toBeInTheDocument();
  expect(within(claude).getByText('1 of 8 slots')).toBeInTheDocument();
  expect(within(team).getByText('Grok').closest('li')).toHaveAttribute('data-status', 'held');
  expect(screen.getByRole('heading', { name: /1 executive · 2 teammates/ })).toBeInTheDocument();
});

it('falls back to initials when an avatar image fails, and for members without one', async () => {
  stub({ '/api/verse/leader/office': office, '/api/verse/fleet/runs': runs, '/api/verse/fleet/agent-roster': roster, '/api/verse/seats': { seats: SEATS_FIXTURE } });
  render(<OrgPane {...props} />);
  const leader = await screen.findByRole('region', { name: 'Leader' });
  const img = leader.querySelector('img')!;
  expect(img).toHaveAttribute('src', '/phantom-mark.svg');
  fireEvent.error(img);
  expect(leader.querySelector('img')).toBeNull();
  expect(within(leader).getByText('LE')).toBeInTheDocument();
  const team = screen.getByRole('region', { name: 'Teammates' });
  expect(within(team).getByText('CL')).toBeInTheDocument();
});

it('names the sources that are down instead of rendering an empty team', async () => {
  stub({ '/api/verse/fleet/runs': runs });
  render(<OrgPane {...props} />);
  expect(await screen.findByText(/Not reported right now: org chart, claims, models\./)).toBeInTheDocument();
  expect(screen.getByText('No executives reported.')).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Teammates' })).toHaveTextContent('Claude');
});
