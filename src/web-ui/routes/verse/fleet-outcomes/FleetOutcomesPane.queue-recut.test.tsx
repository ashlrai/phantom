import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetOutcomesPane } from './FleetOutcomesPane.js';
import { readOutcomes } from './fleet-outcomes-model.js';
import { recutJob } from './recut-job-body.js';

const path = '/api/verse/fleet/live/drop-jobs';
const feedback = {
  v: 1, state: 'current', feedback: { sourceState: 'healthy', cases: [
    { caseId: 'RQ-PHX-EXAMPLE31', outcome: 'failed', lane: 'codex-personal', failureKind: 'DIRTY', prNumber: 1234 },
    { caseId: 'RQ-PHX-NOPR31', outcome: 'failed' },
  ] },
};
let getStatus: number;
let postStatus: number;
let fetchMock: ReturnType<typeof vi.fn>;
const token = 'a'.repeat(64);

beforeEach(() => {
  sessionStorage.clear();
  evictAll();
  getStatus = 200;
  postStatus = 200;
  setMutationToken(token);
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-01T00:10:00Z'));
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === path) {
      const status = init?.method === 'POST' ? postStatus : getStatus;
      return Response.json(status === 200 ? { v: 1, items: [] } : { error: status === 400 ? 'Invalid job body.' : 'not found' }, { status });
    }
    return Response.json(feedback);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); clearMutationToken(); evictAll(); sessionStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const mount = () => render(<FleetOutcomesPane {...({ visible: true, host: { openPane: vi.fn() } } as unknown as PaneProps)} />);

it('hides queue recut when the drop API answers 404, keeping Order recut', async () => {
  getStatus = 404;
  mount();
  expect(await screen.findByRole('button', { name: 'Order recut of RQ-PHX-EXAMPLE31' })).toBeInTheDocument();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(path, expect.objectContaining({ method: 'GET' })));
  expect(screen.queryByRole('button', { name: /^Queue recut/ })).not.toBeInTheDocument();
});

it('posts the exact recut job with mutation authority and invalidates the drop list', async () => {
  mount();
  const button = await screen.findByRole('button', { name: 'Queue recut of RQ-PHX-EXAMPLE31' });
  expect(screen.queryByRole('button', { name: 'Queue recut of RQ-PHX-NOPR31' })).not.toBeInTheDocument();
  fireEvent.click(button);
  expect(await screen.findByText('queued · waiting for ingest')).toBeInTheDocument();
  const expected = recutJob(readOutcomes(feedback)!.cases[0]!, Date.now());
  expect(fetchMock).toHaveBeenCalledWith(path, expect.objectContaining({
    method: 'POST', body: JSON.stringify(expected),
    headers: { 'Content-Type': 'application/json', 'x-ashlr-token': token },
  }));
  await waitFor(() => expect(fetchMock.mock.calls.filter(([url, init]) => url === path && init?.method === 'GET')).toHaveLength(2));
  expect(screen.getByRole('button', { name: /^Queue recut/ })).toBeDisabled();
});

it('shows already queued inline on a duplicate ID', async () => {
  postStatus = 409;
  mount();
  fireEvent.click(await screen.findByRole('button', { name: /^Queue recut/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent('already queued');
  expect(screen.queryByText(/^Queued as/)).not.toBeInTheDocument();
});

it.each([404, 400])('shows the POST refusal inline (HTTP %s)', async status => {
  postStatus = status;
  mount();
  fireEvent.click(await screen.findByRole('button', { name: /^Queue recut/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent(status === 404 ? 'unavailable' : 'Invalid job body.');
});

it('requires a mutation hold before queueing', async () => {
  clearMutationToken();
  mount();
  const button = await screen.findByRole('button', { name: /^Queue recut/ });
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
});

it('waits for the drop GET before offering queue recut', async () => {
  let answer!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { answer = resolve; });
  fetchMock.mockImplementation(async (url: string) => url === path ? pending : Response.json(feedback));
  mount();
  await screen.findByRole('list', { name: 'Cases' });
  expect(screen.queryByRole('button', { name: /^Queue recut/ })).not.toBeInTheDocument();
  answer(Response.json({ v: 1, items: [] }));
  expect(await screen.findByRole('button', { name: /^Queue recut/ })).toBeInTheDocument();
});
