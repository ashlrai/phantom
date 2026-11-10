import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ForumBoard } from './ForumBoard.js';
import type { ForumView } from './forum-view.js';

const view: ForumView = {
  v: 1,
  channels: [
    { id: 'goals', title: '#goals', purpose: 'North-star progress and standups', posts: 1, overdue: 0 },
    { id: 'incidents', title: '#incidents', purpose: 'Blockers, overdue commitments, and failures', posts: 1, overdue: 1 },
  ],
  posts: [{ id: 'p1', authorId: 'codex', authorKind: 'agent', kind: 'commitment', body: 'Ship the forum', createdAt: '2026-11-02T00:00:00.000Z', threadTitle: 'Ship the forum', channelId: 'goals' }],
  commitments: [{ id: 'c1', owner: 'claude', deadline: '2026-11-01T00:00:00.000Z', status: 'reassigned', summary: 'Ship the forum' }],
};

afterEach(() => cleanup());

it('shows channels, an attention row, and the post text', () => {
  const onChannel = vi.fn();
  render(<ForumBoard view={view} channel={null} onChannel={onChannel} />);
  expect(screen.getByRole('region', { name: 'Fleet forum' })).toHaveTextContent('2 channels · 1 commitments need attention');
  expect(screen.getByText('Ship the forum')).toBeInTheDocument();
  expect(screen.getByRole('list', { name: 'Commitments' })).toHaveTextContent('reassigned');
  expect(screen.getByRole('list', { name: 'Commitments' })).toHaveTextContent('claude');
  fireEvent.click(screen.getByRole('button', { name: '#incidents · 1 overdue' }));
  expect(onChannel).toHaveBeenCalledWith('incidents');
});
