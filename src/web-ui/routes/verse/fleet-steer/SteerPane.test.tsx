import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { SteerPane } from './SteerPane.js';

const props = { visible: true } as PaneProps;
const SECRET = 'sk-' + 'probe'.repeat(20);

const queue = [
  { id: 'RQ-READY-1', status: 'READY', priority: 'P2', pool: 'devin', tier: 'mid', scope: 'ready scope' },
  { id: 'RQ-HOLD-1', status: 'HOLD', priority: 'P3', pool: 'devin', tier: 'mid', scope: 'held scope' },
  { id: 'RQ-LIVE-1', status: 'CLAIMED', priority: 'P1', pool: 'devin', tier: 'mid', scope: 'live scope' },
  { id: 'RQ-DONE-1', status: 'DONE', priority: 'P0', pool: 'devin', tier: 'mid', scope: 'done scope' },
];

const snapshot = (agentTask = 'ship the steer pane') => ({
  v: 1,
  generatedAt: '2026-11-10T00:00:00Z',
  fleet: {
    schema: 'fleet.v1',
    generated_at: '2026-11-10T00:00:00Z',
    agents: [
      { agent: 'devin', repo: 'ashlrai/phantom', task: agentTask, claim_id: 'present', expires_at: '2126-01-01T00:00:00Z' },
      { agent: 'claude', repo: null, task: null, expires_at: null },
    ],
    pools: [{ id: 'devin', shared_with: null }, { id: 'claude-max' }],
  },
  fleetState: 'ok',
  seats: [],
  seatsState: 'ok',
  queue,
  queueState: 'ok',
});

let posts: Record<string, unknown>[];
const stubFetch = (read: unknown, postResponse: unknown = { v: 1, dryRun: false, outcome: 'accepted', count: 41 }, postStatus = 200) => {
  posts = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      return Response.json(postResponse, { status: postStatus });
    }
    return Response.json(read);
  }));
};

beforeEach(() => { evictAll(); clearMutationToken(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); clearMutationToken(); });

it('renders the #945 roster grouped by team with claims, and lists queue lines', async () => {
  stubFetch(snapshot());
  render(<SteerPane {...props} />);
  const roster = await screen.findByRole('list', { name: 'Agent roster' });
  expect(roster).toHaveTextContent('Devin');
  expect(roster).toHaveTextContent('Claude Max');
  expect(roster).toHaveTextContent('ship the steer pane');
  expect(roster).toHaveTextContent('1 claim');
  // Claimed and finished lines never appear in the reprioritize picker.
  const lines = within(screen.getByLabelText('Queue line')).getAllByRole('option');
  expect(lines.map((o) => o.textContent)).toEqual([
    'Select a line', 'RQ-READY-1 · READY · P2', 'RQ-HOLD-1 · HOLD · P3',
  ]);
  const stops = within(screen.getByLabelText('Job to stop')).getAllByRole('option');
  expect(stops.map((o) => o.textContent)).toEqual([
    'Select a job', 'RQ-READY-1 · READY · P2', 'RQ-HOLD-1 · HOLD · P3', 'RQ-LIVE-1 · CLAIMED · P1',
  ]);
});

it('sends a steer note through POST /api/wb/v1/action with a fresh nonce', async () => {
  setMutationToken('a'.repeat(64));
  stubFetch(snapshot());
  render(<SteerPane {...props} />);
  await screen.findByRole('list', { name: 'Agent roster' });
  const box = screen.getByRole('group', { name: 'Steer note' });
  fireEvent.change(within(box).getByRole('textbox', { name: 'Steer note' }), { target: { value: 'hold codex until the release lands' } });
  fireEvent.click(within(box).getByRole('button', { name: 'Send note' }));
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0]).toMatchObject({ action: 'steer.note', text: 'hold codex until the release lands', dryRun: false });
  expect(posts[0]?.nonce).toMatch(/^[a-f0-9]{32}$/);
  await screen.findByText("note sent to the leaders' inbox · 41 bytes");
});

it('reprioritizes a queue line and refuses before posting when fields are missing', async () => {
  setMutationToken('a'.repeat(64));
  stubFetch(snapshot(), { v: 1, dryRun: false, outcome: 'P2>P0' });
  render(<SteerPane {...props} />);
  const box = await screen.findByRole('group', { name: 'Reprioritize a queue line' });
  const button = within(box).getByRole('button', { name: 'Reprioritize' });
  expect(button).toBeDisabled();
  fireEvent.change(within(box).getByLabelText('Queue line'), { target: { value: 'RQ-READY-1' } });
  fireEvent.change(within(box).getByLabelText('New priority'), { target: { value: 'P0' } });
  fireEvent.click(button);
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0]).toMatchObject({ action: 'queue.reprioritize', job: 'RQ-READY-1', priority: 'P0', dryRun: false });
  await screen.findByText('RQ-READY-1 · P2 → P0');
});

it('stops a job only on the second click of the armed button', async () => {
  setMutationToken('a'.repeat(64));
  stubFetch(snapshot(), { v: 1, dryRun: false, outcome: 'stopped', count: 2 });
  render(<SteerPane {...props} />);
  const box = await screen.findByRole('group', { name: 'Stop a job' });
  fireEvent.change(within(box).getByLabelText('Job to stop'), { target: { value: 'RQ-LIVE-1' } });
  const button = within(box).getByRole('button', { name: 'Stop RQ-LIVE-1' });
  fireEvent.click(button);
  expect(button).toHaveTextContent('Stop RQ-LIVE-1? click again');
  expect(posts).toHaveLength(0);
  fireEvent.click(button);
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0]).toMatchObject({ action: 'job.stop', job: 'RQ-LIVE-1', dryRun: false });
  await screen.findByText('RQ-LIVE-1 · stopped 2 processes');
});

it('requires the mutation token and never posts without it', async () => {
  stubFetch(snapshot());
  render(<SteerPane {...props} />);
  const box = await screen.findByRole('group', { name: 'Steer note' });
  fireEvent.change(within(box).getByRole('textbox', { name: 'Steer note' }), { target: { value: 'go' } });
  fireEvent.click(within(box).getByRole('button', { name: 'Send note' }));
  await screen.findByText('Unlock actions with the mutation token before changing the loop.');
  expect(posts).toHaveLength(0);
});

it('never renders secret-shaped read data or echoes secret-shaped input in results', async () => {
  setMutationToken('a'.repeat(64));
  // A secret-shaped agent task: the roster adapter scrubs it before render.
  stubFetch(snapshot(`ship it ${SECRET}`), { error: 'invalid action' }, 400);
  render(<SteerPane {...props} />);
  const roster = await screen.findByRole('list', { name: 'Agent roster' });
  expect(roster).not.toHaveTextContent(SECRET);
  const box = screen.getByRole('group', { name: 'Steer note' });
  fireEvent.change(within(box).getByRole('textbox', { name: 'Steer note' }), { target: { value: `key ${SECRET}` } });
  fireEvent.click(within(box).getByRole('button', { name: 'Send note' }));
  await screen.findByText('That action was refused; check the fields.');
  expect(within(box).getByRole('status')).not.toHaveTextContent(SECRET);
});

it('shows the honest source states instead of an empty roster', async () => {
  stubFetch({ ...snapshot(), fleetState: 'missing', fleet: null, queueState: 'unavailable', queue: [], seatsState: 'unavailable' });
  render(<SteerPane {...props} />);
  await screen.findByText('The fleet roster is unavailable; the queue and actions still work.');
  await screen.findByText('Roster unavailable.');
});
