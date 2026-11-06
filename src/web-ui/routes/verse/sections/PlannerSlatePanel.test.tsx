import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { PlannerSlatePanel } from './PlannerSlatePanel.js';

const slate = { v: 1, generatedAt: '2026-11-01T00:08:00Z', source: 'missing', path: 'queue/planner-candidates.json', candidates: [],
  promptPath: null, promptExists: false, promptAgeSeconds: null,
  presets: [{ id: 'codex-personal', provider: 'codex', available: true, binary: 'codex', dropDir: 'queue' },
    { id: 'claude', provider: 'claude', available: false, binary: null, dropDir: 'queue' }],
  briefCandidates: [{ path: 'queue/planner-brief.prompt', exists: true, ageSeconds: 240 }] };
beforeEach(() => { evictAll(); clearMutationToken(); setMutationToken('test-only'); });
afterEach(() => { cleanup(); clearMutationToken(); vi.unstubAllGlobals(); });
function mount(status = 200) {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({ v: 1, status: 'written', candidateCount: 1, promptPath: 'queue/planner-brief.prompt' })
    : Response.json(slate, { status }));
  vi.stubGlobal('fetch', fetcher);
  render(<ToastProvider><PlannerSlatePanel /></ToastProvider>);
  return fetcher;
}
it('saves a selected login and refreshes the slate', async () => {
  const fetcher = mount();
  expect(await screen.findByText('No planner logins declared: the fleet cannot plan for itself')).toHaveAttribute('data-tone', 'warn');
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  expect(screen.getByRole('switch', { name: 'claude' })).toBeDisabled();
  expect(screen.getByText('claude not found on this Mac')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('switch', { name: 'codex-personal' }));
  expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('Planner logins saved.')).toBeInTheDocument();
  const post = fetcher.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(JSON.parse(String(post?.[1]?.body))).toEqual({ presets: ['codex-personal'] });
  await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'GET')).toHaveLength(2));
});
it('hides the panel when the route is absent', async () => {
  const fetcher = mount(404);
  await waitFor(() => expect(fetcher).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByText('Planner logins')).not.toBeInTheDocument());
});
it('shows the control lock instead of Save', async () => {
  clearMutationToken(); mount();
  expect(await screen.findByText(/Unlock actions with the mutation token/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
});
