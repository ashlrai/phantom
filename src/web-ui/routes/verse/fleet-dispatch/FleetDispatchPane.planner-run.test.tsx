import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { getVerseUiState, setVerseSection } from '../verse-ui-store.js';
import { FleetDispatchPane } from './FleetDispatchPane.js';
import { setPlannerRun } from './planner-run-store.js';

const props = { visible: true, roots: [], host: {} } as unknown as PaneProps;
const plan = { v: 1, generatedAt: '2026-11-01T11:00:00Z', path: 'candidates', source: 'ok', choice: { provider: 'codex-personal', reason: 'ok' }, nextResetAt: null, limited: [], health: [] };
const empty = { startedAt: null, finishedAt: null, ok: null, text: null, needsSlate: false };

beforeEach(() => { evictAll(); setPlannerRun(empty); setMutationToken('test-only'); setVerseSection('chat'); });
afterEach(() => { cleanup(); clearMutationToken(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('posts once, shows a pending run across remount, and retains its outcome', async () => {
  let resolvePost!: (response: Response) => void;
  const post = new Promise<Response>(resolve => { resolvePost = resolve; });
  const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return post;
    return Promise.resolve(Response.json(String(input).endsWith('/planner/plan') ? plan : fleetRunsFixture({ claudeLane: null })));
  });
  vi.stubGlobal('fetch', fetcher);
  const view = render(<FleetDispatchPane {...props} />);
  const button = await screen.findByRole('button', { name: 'Run planner pass' });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  expect(button).toBeDisabled();
  expect(screen.getByText(/Planner pass running since .* \(up to 20 min\)/)).toBeInTheDocument();
  const posts = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(posts).toHaveLength(1);
  expect(posts[0]![0]).toBe('/api/verse/leader/planner/run');
  expect(JSON.parse(String(posts[0]![1]?.body))).toEqual({ reason: 'Dispatch pane' });
  view.unmount();
  const remount = render(<FleetDispatchPane {...props} />);
  expect(await screen.findByText(/Planner pass running since/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Run planner pass' })).toBeDisabled();
  await act(async () => { resolvePost(Response.json({ v: 1, provider: 'codex-personal', outcome: 'ran', exitCode: 0 })); await post; });
  expect(await screen.findByText(/Last pass .*: ran on codex-personal \(exit 0\)/)).toBeInTheDocument();
  await waitFor(() => expect(fetcher.mock.calls.filter(([input]) => String(input).endsWith('/planner/plan')).length).toBeGreaterThanOrEqual(2));
  remount.unmount();
  render(<FleetDispatchPane {...props} />);
  expect(await screen.findByText(/Last pass .*: ran on codex-personal \(exit 0\)/)).toBeInTheDocument();
}, 20_000);

it('offers Settings for a no-slate refusal', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return Response.json({ error: 'no-slate' }, { status: 409 });
    return Response.json(String(input).endsWith('/planner/plan') ? plan : fleetRunsFixture({ claudeLane: null }));
  }));
  render(<FleetDispatchPane {...props} />);
  const button = await screen.findByRole('button', { name: 'Run planner pass' });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  expect(await screen.findByText('No planner slate declared: declare logins in Settings')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));
  expect(getVerseUiState().section).toBe('settings');
});
