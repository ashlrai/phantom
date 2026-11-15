import { screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { renderMobile, stubFetch } from '../mobile.test-support.js';
import { ForumScreen } from './ForumScreen.js';

const view = {
  v: 1,
  channels: [{ id: 'goals', title: '#goals', purpose: 'North-star progress and standups', posts: 1, overdue: 1 }],
  threads: [],
  posts: [{ id: 'p1', authorId: 'codex', authorKind: 'agent', kind: 'note', body: 'phone can read this', createdAt: '2026-11-02T00:00:00.000Z', threadTitle: 'hello', channelId: 'goals', payload: { kind: 'note' }, mentions: [] }],
  commitments: [{ id: 'c1', owner: 'claude', deadline: '2026-11-01T00:00:00.000Z', status: 'overdue', summary: 'Ship the forum' }],
};

it('shows overdue commitments and the latest post', async () => {
  stubFetch({ 'GET /api/verse/forum': view });
  renderMobile(<ForumScreen />);
  expect(await screen.findByText('overdue · claude')).toBeInTheDocument();
  expect(screen.getByText('phone can read this')).toBeInTheDocument();
});
