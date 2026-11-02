import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { FleetLanesPane } from './FleetLanesPane.js';

const lane = { lane: 'codex', running: 1, target: 2, queued: 3, held: false, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null };
const runs: FleetRuns = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [lane, { ...lane, lane: 'claude', target: 1 }], workers: [], leaders: [], orchestratorAgents: null,
  publishesLastHour: [], mergesLastHour: { count: 0, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};
const targetRow = { lane: 'codex', target: 2, floor: 0, ceiling: 999, held: false, heldReason: null, heldUntil: null, lastChange: null, changedBy: null };
const targets = () => ({ v: 1, generatedAt: '2026-10-31T12:00:00Z', sourceState: 'healthy', lanes: [targetRow, { ...targetRow, lane: 'claude', target: 1 }] });
const json = (value: unknown, status = 200) => Response.json(value, { status });
function row(name: string) { return screen.getByText(name, { selector: 'strong' }).closest('li')!; }

beforeEach(() => { evictAll(); clearMutationToken(); });
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('changes a lane target and shows the saved value', async () => {
  setMutationToken('a'.repeat(64));
  let current = targets();
  let finish!: (response: Response) => void;
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return new Promise<Response>(resolve => { finish = resolve; });
    return Promise.resolve(json(url.endsWith('/control/lanes') ? current : runs));
  });
  vi.stubGlobal('fetch', fetcher);
  render(<FleetLanesPane visible />);
  const raise = await screen.findByRole('button', { name: 'Raise codex target' });
  await vi.waitFor(() => expect(raise).toBeEnabled());
  for (const name of ['codex', 'claude']) {
    expect(within(row(name)).getByRole('button', { name: `Lower ${name} target` })).toBeEnabled();
    expect(within(row(name)).getByRole('button', { name: `Raise ${name} target` })).toBeEnabled();
  }
  fireEvent.click(raise);
  expect(JSON.parse(String(fetcher.mock.calls.find(([, init]) => init?.method === 'POST')![1]!.body))).toEqual({ lane: 'codex', target: 3 });
  expect(within(row('claude')).getByRole('button', { name: 'Raise claude target' })).toBeDisabled();
  current = { ...current, lanes: [{ ...targetRow, target: 3 }, current.lanes[1]] };
  await act(async () => { finish(json(current)); });
  expect(within(row('codex')).getByRole('status')).toHaveTextContent('Saved');
  expect(within(row('codex')).getByText('3', { selector: 'span' })).toBeInTheDocument();
});

it('shows the busy refusal on the affected row', async () => {
  setMutationToken('a'.repeat(64));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => init?.method === 'POST' ? json({ code: 'busy' }, 409) : json(url.endsWith('/control/lanes') ? targets() : runs)));
  render(<FleetLanesPane visible />);
  const raise = await screen.findByRole('button', { name: 'Raise codex target' });
  await vi.waitFor(() => expect(raise).toBeEnabled());
  fireEvent.click(raise);
  expect(await within(row('codex')).findByRole('status')).toHaveTextContent('Another fleet control action is running, try again in a moment.');
});

it('shows the server reason for other refusals', async () => {
  setMutationToken('a'.repeat(64));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => init?.method === 'POST' ? json({ error: 'The target is outside the permitted range.' }, 422) : json(url.endsWith('/control/lanes') ? targets() : runs)));
  render(<FleetLanesPane visible />);
  const raise = await screen.findByRole('button', { name: 'Raise codex target' });
  await vi.waitFor(() => expect(raise).toBeEnabled());
  fireEvent.click(raise);
  expect(await within(row('codex')).findByRole('status')).toHaveTextContent('The target is outside the permitted range.');
});

it('falls back to read-only snapshot targets when the endpoint is missing', async () => {
  setMutationToken('a'.repeat(64));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/control/lanes') ? json({}, 404) : json(runs)));
  render(<FleetLanesPane visible />);
  const lower = await screen.findByRole('button', { name: 'Lower codex target' });
  await vi.waitFor(() => expect(lower).toHaveAttribute('title', 'Lane targets are not in this build'));
  expect(lower).toBeDisabled();
  expect(within(row('codex')).getByRole('button', { name: 'Raise codex target' })).toBeDisabled();
  expect(within(row('codex')).getByText('2', { selector: 'span' })).toBeInTheDocument();
});

it('requires confirmation before setting zero', async () => {
  setMutationToken('a'.repeat(64));
  let current = targets();
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { current = { ...current, lanes: [current.lanes[0], { ...current.lanes[1], target: 0 }] }; return json(current); }
    return json(url.endsWith('/control/lanes') ? current : runs);
  });
  vi.stubGlobal('fetch', fetcher);
  render(<FleetLanesPane visible />);
  const lower = await screen.findByRole('button', { name: 'Lower claude target' });
  await vi.waitFor(() => expect(lower).toBeEnabled());
  fireEvent.click(lower);
  expect(within(row('claude')).getByText('Press − again to set 0')).toBeInTheDocument();
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  fireEvent.click(lower);
  await within(row('claude')).findByText('Saved');
  expect(JSON.parse(String(fetcher.mock.calls.find(([, init]) => init?.method === 'POST')![1]!.body))).toEqual({ lane: 'claude', target: 0 });
});
