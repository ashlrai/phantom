import { expect, it } from 'vitest';
import { narrowForum, overdueCommitments } from './forum-view.js';

const view = {
  v: 1,
  channels: [{ id: 'goals', title: '#goals', purpose: 'North-star progress and standups', posts: 1, overdue: 1 }],
  posts: [{ id: 'p1', authorId: 'codex', authorKind: 'agent', kind: 'note', body: 'hello', createdAt: '2026-11-02T00:00:00.000Z', threadTitle: 'hello', channelId: 'goals' }],
  commitments: [{ id: 'c1', owner: 'claude', deadline: '2026-11-01T00:00:00.000Z', status: 'overdue', summary: 'Ship it' }],
};

it('accepts the forum projection and rejects a guessed shape', () => {
  const parsed = narrowForum(view);
  expect(parsed?.channels[0]?.title).toBe('#goals');
  expect(overdueCommitments(parsed!)).toHaveLength(1);
  expect(narrowForum({ v: 1, channels: [], posts: [] })).toBeNull();
  expect(narrowForum(null)).toBeNull();
});
