import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AGENT_DECISION_EVENT } from './agent-decisions.js';
import { approveProposal, rejectProposal } from './mutations.js';
import { clearMutationToken, setMutationToken } from './auth-store.js';

beforeEach(() => setMutationToken('b'.repeat(64)));
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); });
it.each([['approve', approveProposal, 'approve'], ['deny', rejectProposal, 'reject']] as const)('emits %s only after the server accepts it', async (decision, action, endpoint) => {
  const listener = vi.fn();
  window.addEventListener(AGENT_DECISION_EVENT, listener);
  const fetcher = vi.fn(async () => Response.json({ ok: true }));
  vi.stubGlobal('fetch', fetcher);
  try {
    await action('p/1');
    expect(fetcher).toHaveBeenCalledWith(`/api/inbox/p%2F1/${endpoint}`, expect.objectContaining({ method: 'POST' }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].detail).toEqual({ id: 'p/1', decision });
  } finally { window.removeEventListener(AGENT_DECISION_EVENT, listener); }
});
it.each([approveProposal, rejectProposal])('does not announce a failed decision', async (action) => {
  const listener = vi.fn();
  window.addEventListener(AGENT_DECISION_EVENT, listener);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
  try {
    await expect(action('p1')).rejects.toThrow();
    expect(listener).not.toHaveBeenCalled();
  } finally { window.removeEventListener(AGENT_DECISION_EVENT, listener); }
});
