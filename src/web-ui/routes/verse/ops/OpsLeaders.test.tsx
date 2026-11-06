/**
 * Component test: the leaders' channel renders fixture bus state (roster,
 * transcript, open handoffs, pending approvals) and posts through the same
 * bus endpoint `phm team say` semantics use, under the mutation token.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { evictAll } from '../../../data/cache.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { OpsLeaders } from './OpsLeaders.js';
import { VERSE_OPS_LEADERS_MESSAGES_PATH } from '../../../../core/verse/ops-types.js';
import type { OpsLeadersV1 } from '../../../../core/verse/ops-types.js';

const token = 'c'.repeat(64);

function member(over: Partial<OpsLeadersV1['leaders'][number]> = {}): OpsLeadersV1['leaders'][number] {
  return {
    id: 'human:mason', kind: 'human', role: 'owner', provider: null, onBehalfOf: null,
    capabilities: [], online: true, lastSeenAt: '2026-10-30T10:00:00Z', leader: true, ...over,
  };
}

function fixture(over: Partial<OpsLeadersV1> = {}): OpsLeadersV1 {
  return {
    v: 1,
    generatedAt: '2026-10-30T10:05:00Z',
    team: 'default',
    channel: 'leaders',
    leaders: [
      member(),
      member({ id: 'agent:grok-bot/mason', kind: 'agent', role: 'agent', provider: 'grok-bot', onBehalfOf: 'human:mason', capabilities: ['leader'], online: false }),
      member({ id: 'human:casey', role: 'member', online: true, leader: false }),
    ],
    channels: [{ channel: 'leaders', count: 2 }, { channel: 'general', count: 7 }],
    messages: [
      { id: 'm1', from: 'human:mason', at: '2026-10-30T09:00:00Z', text: 'Hold the fleet until the release lands.' },
      { id: 'm2', from: 'agent:grok-bot/mason', at: '2026-10-30T09:05:00Z', text: 'Acknowledged. Standing by.' },
    ],
    openHandoffs: [{ id: 'h9', from: 'human:mason', to: 'agent:grok-bot/mason', title: 'Prep the changelog', state: 'accepted', updatedAt: '2026-10-30T09:30:00Z' }],
    pendingApprovals: [{ id: 'a2', handoffId: 'h8', action: 'merge-pr', requestedBy: 'agent:codex/mason' }],
    canPost: true,
    ...over,
  };
}

function stubRead(value: unknown) {
  const posts: { path: string; body: Record<string, unknown>; headers: Headers }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ path: String(input), body: JSON.parse(String(init.body)) as Record<string, unknown>, headers: new Headers(init.headers) });
      return Response.json({ ok: true }, { status: 201 });
    }
    return Response.json(value);
  }));
  return posts;
}

beforeEach(() => { evictAll(); clearMutationToken(); localStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); clearMutationToken(); });

describe('OpsLeaders', () => {
  it('renders the leaders, transcript and open bus items from fixtures', async () => {
    stubRead(fixture());
    render(<OpsLeaders />);
    // The member chip and the message author both show the id.
    await screen.findAllByText('human:mason');
    expect(screen.getAllByText('agent:grok-bot/mason').length).toBeGreaterThan(0);
    expect(screen.getByText('Hold the fleet until the release lands.')).toBeInTheDocument();
    expect(screen.getByText('Acknowledged. Standing by.')).toBeInTheDocument();
    expect(screen.getByText(/Prep the changelog/)).toBeInTheDocument();
    expect(screen.getByText(/merge-pr requested by agent:codex\/mason/)).toBeInTheDocument();
  });

  it('posts a message to the leaders channel under the mutation token', async () => {
    setMutationToken(token);
    const posts = stubRead(fixture());
    const user = userEvent.setup();
    render(<OpsLeaders />);
    await screen.findByText('Hold the fleet until the release lands.');
    await user.type(screen.getByLabelText('Post to #leaders'), 'Ship it when green');
    await user.click(screen.getByRole('button', { name: 'Post to leaders' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.path).toBe(VERSE_OPS_LEADERS_MESSAGES_PATH);
    expect(posts[0]!.body).toEqual({ text: 'Ship it when green' });
    expect(posts[0]!.headers.get('x-ashlr-token')).toBe(token);
  });

  it('disables the composer when the read says posting is unavailable', async () => {
    stubRead(fixture({ canPost: false }));
    render(<OpsLeaders />);
    await screen.findAllByText('human:mason');
    expect(screen.getByRole('button', { name: 'Post to leaders' })).toBeDisabled();
    expect(screen.getByText('Read-only: posting needs dispatch on.')).toBeInTheDocument();
  });
});
