import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { PinnedGroup, PinToggle } from './LibraryPins.js';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const pin = { id: 'pin_aaaaaaaaaaaa', kind: 'memory', ref: '/work/alpha', title: 'alpha memory', pinnedAt: '2026-11-09T08:00:00.000Z' };

function stubPins(initial: unknown[]) {
  let pins = initial;
  const posts: unknown[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (!url.startsWith('/api/verse/library/pins')) return json({ error: 'not found' }, 404);
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, string>;
      posts.push({ body, token: (init.headers as Record<string, string>)['x-ashlr-token'] });
      pins = body.remove ? pins.filter((row) => (row as { id: string }).id !== body.remove)
        : [{ ...pin, id: 'pin_bbbbbbbbbbbb', kind: body.kind, ref: body.ref, title: body.title }, ...pins];
      return json({ v: 1, pins });
    }
    return json({ v: 1, pins });
  });
  vi.stubGlobal('fetch', fetchMock);
  return posts;
}

beforeEach(() => { evictAll(); setMutationToken('t'.repeat(64)); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('Library pins', () => {
  it('pin toggle posts the pin, then the unpin, with the mutation token', async () => {
    const posts = stubPins([]);
    render(<PinToggle kind="bus" pinRef="m7" title="worker → leader: shipped" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Pin worker → leader: shipped' }));
    const unpin = await screen.findByRole('button', { name: 'Unpin worker → leader: shipped' });
    expect(unpin).toHaveAttribute('aria-pressed', 'true');
    expect(posts[0]).toEqual({ body: { kind: 'bus', ref: 'm7', title: 'worker → leader: shipped' }, token: 't'.repeat(64) });
    fireEvent.click(unpin);
    await screen.findByRole('button', { name: 'Pin worker → leader: shipped' });
    expect(posts[1]).toMatchObject({ body: { remove: 'pin_bbbbbbbbbbbb' } });
  });

  it('renders the Pinned group only when something is pinned', async () => {
    stubPins([pin]);
    render(<PinnedGroup />);
    const group = await screen.findByRole('region', { name: 'Pinned' });
    expect(within(group).getByText('alpha memory')).toBeInTheDocument();
    expect(within(group).getByText('/work/alpha')).toBeInTheDocument();
    evictAll();
    stubPins([]);
    const { container } = render(<PinnedGroup />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('shows no toggle on a server without the pins route', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'not found' }, 404)));
    const { container } = render(<PinToggle kind="memory" pinRef="/work/alpha" title="alpha memory" />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
