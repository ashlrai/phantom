import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { AGENT_DECISION_EVENT } from '../../../data/agent-decisions.js';
import { DecisionInbox } from './DecisionInbox.js';

beforeEach(() => evictAll());
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); });
it('shows an empty state after a successful read', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ proposals: [], pending: 0 })));
  render(<DecisionInbox />);
  expect(await screen.findByText(/No pending decisions/)).toBeInTheDocument();
});
it('shows an error instead of an empty state and retries', async () => {
  let failed = true;
  vi.stubGlobal('fetch', vi.fn(async () => failed ? new Response('', { status: 500 }) : Response.json({ proposals: [], pending: 0 })));
  render(<DecisionInbox />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load decisions');
  expect(screen.queryByText(/No pending decisions/)).not.toBeInTheDocument();
  failed = false;
  await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText(/No pending decisions/)).toBeInTheDocument();
});
it('lists pending proposals with their origin and repository', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ pending: 1, proposals: [{ id: 'p1', title: 'Fix crash', origin: 'agent', kind: 'patch', repo: '/repo' }] })));
  render(<DecisionInbox />);
  expect(await screen.findByRole('button', { name: 'Fix crash' })).toBeInTheDocument();
  expect(screen.getByText('agent · patch · /repo')).toBeInTheDocument();
});

it.each([['Approve…', 'approve'], ['Deny', 'deny']] as const)('reviews and confirms %s before emitting a local event', async (label, decision) => {
  const user = userEvent.setup();
  const listener = vi.fn();
  let decided = false;
  const proposal = { id: 'p1', title: 'Fix crash', summary: 'Handle a missing value.', origin: 'agent', kind: 'patch', repo: '/repo', status: 'pending', createdAt: new Date().toISOString(), diff: '', decisionEvidence: { decisions: [], sourceQuality: { state: 'ok' } } };
  setMutationToken('b'.repeat(64));
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') { decided = true; return Response.json({ ok: true }); }
    if (String(input) === '/api/verse/bootstrap') return Response.json({ dispatchEnabled: true });
    if (String(input) === '/api/inbox/p1') return Response.json(proposal);
    return Response.json({ pending: decided ? 0 : 1, proposals: decided ? [] : [proposal] });
  }));
  window.addEventListener(AGENT_DECISION_EVENT, listener);
  try {
    render(<DecisionInbox />);
    await user.click(await screen.findByRole('button', { name: 'Fix crash' }));
    await user.click(await screen.findByRole('button', { name: label }));
    expect(listener).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: decision === 'approve' ? 'Approve and apply' : 'Reject' }));
    await waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    expect(listener.mock.calls[0][0].detail).toEqual({ id: 'p1', decision });
    expect(await screen.findByText(/No pending decisions/)).toBeInTheDocument();
  } finally { window.removeEventListener(AGENT_DECISION_EVENT, listener); }
});
