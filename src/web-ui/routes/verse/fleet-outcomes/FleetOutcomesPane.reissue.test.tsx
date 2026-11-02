import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetOutcomesPane } from './FleetOutcomesPane.js';
afterEach(() => { cleanup(); clearMutationToken(); evictAll(); vi.unstubAllGlobals(); });
it.each([202, 409])('offers eligible rows, posts once and shows the response (%s)', async status => {
  evictAll();
  setMutationToken('a'.repeat(64));
  const path = '/api/verse/outcomes/fleet-reissue';
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST'
    ? Response.json(status === 202 ? { outcome: 'written', newId: 'EMPTY31R1' } : { error: 'Prompt missing' }, { status })
    : Response.json( { v: 1, state: 'current', feedback: { sourceState: 'healthy', cases: [
      { caseId: 'RQ-PHX-EMPTY31', endedAt: '2026-11-01T00:00:00Z', outcome: 'failed', lane: 'devin' },
      { caseId: 'RQ-PHX-PUBLISHED31', endedAt: '2026-11-01T00:00:00Z', outcome: 'failed', prNumber: 123 },
      { caseId: 'RQ-PHX-RUNNING31', outcome: 'unknown' },
    ] } }));
  vi.stubGlobal('fetch', fetchMock);
  render(<FleetOutcomesPane {...({ visible: true, host: { openPane: vi.fn() } } as unknown as PaneProps)} />);
  const button = await screen.findByRole('button', { name: 'Re-issue' });
  expect(screen.getAllByRole('button', { name: 'Re-issue' })).toHaveLength(1);
  fireEvent.click(button);
  fireEvent.click(button);
  expect(await screen.findByText(status === 202 ? 're-issued as RQ-PHX-EMPTY31R1' : 'Prompt missing')).toBeInTheDocument();
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  expect(fetchMock).toHaveBeenCalledWith(path, expect.objectContaining({ method: 'POST', body: JSON.stringify({ id: 'RQ-PHX-EMPTY31', lane: 'devin' }),
    headers: { 'Content-Type': 'application/json', 'x-ashlr-token': 'a'.repeat(64) } }));
  if (status === 202) expect(button).toBeDisabled();
  else expect(button).toBeEnabled();
});
