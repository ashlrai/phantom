import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { LibraryPane } from './LibraryPane.js';

vi.mock('../command/nav.js', () => ({ openChat: vi.fn() }));
vi.mock('../dock/dock-store.js', () => ({ openDockPane: vi.fn() }));
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const ok = (handoffs: unknown[], extra: Record<string, unknown> = {}) => ({ v: 1, observedAt: new Date().toISOString(), handoffs, ...extra });
function stub(handoffs: () => Response) {
  stubSurfaceFetch({ routes: {
    '/api/verse/sessions': [],
    '/api/verse/agent-bus/status': () => json({ v: 1, source: 'missing', retainedCount: null, retainedBytes: null, liveCount: null, expiredCount: null, maxMessages: 1, maxBytes: 1 }),
    '/api/verse/agent-bus': () => json({ v: 1, status: 'ok', messages: [], nextCursor: 1 }),
    '/api/verse/fleet/handoffs': handoffs,
  } });
}
beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('LibraryPane handoffs', () => {
  it('renders grouped rows and literal preview text', async () => {
    const modifiedAt = new Date().toISOString();
    stub(() => json(ok([
      { folder: 'alpha', name: 'first.md', size: 12, modifiedAt, preview: '<b>x</b>' },
      { folder: 'beta', name: 'second.md', size: 3, modifiedAt, preview: 'hello' },
    ])));
    const { container } = render(<LibraryPane visible />);
    const alpha = await screen.findByRole('list', { name: 'alpha handoffs' });
    expect(within(alpha).getByText('first')).toBeInTheDocument();
    expect(within(alpha).getByText('<b>x</b>')).toBeInTheDocument();
    expect(container.querySelector('b')).toBeNull();
    expect(within(screen.getByRole('list', { name: 'beta handoffs' })).getByText('second')).toBeInTheDocument();
    expect(screen.getAllByText('1 file')).toHaveLength(2);
  });
  it.each([
    [() => json({}, 404), 'This server does not read handoffs yet.'],
    [() => json(ok([], { state: 'absent' })), 'No handoff folder yet.'],
    [() => json(ok([], { state: 'unavailable' })), 'Handoffs could not be read.'],
    [() => json(ok([])), 'No handoffs.'],
    [() => json({ v: 2 }), 'Handoffs could not be read.'],
  ])('shows the appropriate state', async (response, sentence) => {
    stub(response);
    render(<LibraryPane visible />);
    expect(await screen.findByText(sentence)).toBeInTheDocument();
  });
});
