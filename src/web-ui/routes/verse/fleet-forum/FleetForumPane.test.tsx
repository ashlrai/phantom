import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetForumPane } from './FleetForumPane.js';

const view = {
  v: 1,
  channels: [{ id: 'goals', title: '#goals', purpose: 'North-star progress and standups', posts: 1, overdue: 0 }],
  threads: [],
  posts: [{ id: 'p1', authorId: 'codex', authorKind: 'agent', kind: 'note', body: 'hello from the fleet', createdAt: '2026-11-02T00:00:00.000Z', threadTitle: 'hello', channelId: 'goals', payload: { kind: 'note' }, mentions: [] }],
  commitments: [],
};

afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

it('reads the forum route and shows the post', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    expect(String(input)).toBe('/api/verse/forum');
    return Response.json(view);
  }));
  render(<FleetForumPane {...{ visible: true, host: { openPane: vi.fn() } } as unknown as PaneProps} />);
  expect(await screen.findByText('hello from the fleet')).toBeInTheDocument();
});
