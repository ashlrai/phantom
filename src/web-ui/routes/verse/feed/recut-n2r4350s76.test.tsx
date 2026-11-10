import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { LeaderThreadPane } from '../leader-thread/LeaderThreadPane.js';
import { takeLeaderDraft } from '../leader-thread/leader-draft-store.js';
import { FeedAskButton } from './FeedAskButton.js';

afterEach(() => { takeLeaderDraft(); vi.unstubAllGlobals(); });

it('hands a feed item to the composer without sending or replacing typed text', async () => {
  const net = stubSurfaceFetch({ routes: {
    '/api/verse/leader/thread': { messages: [] },
    '/api/verse/leader/directives': { directives: [] },
  } });
  render(<><LeaderThreadPane visible /><FeedAskButton item={{ id: 'alert:1', at: '2026-01-01T00:00:00Z', kind: 'alert', title: 'Disk is filling' }} /></>);
  const input = await screen.findByRole('textbox', { name: 'Reply to the Leader' });
  fireEvent.change(input, { target: { value: 'My question' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ask Leader about Disk is filling' }));
  expect(input).toHaveValue('My question\n\nAbout: Alert "Disk is filling"\n\n');
  expect(net.posted).toEqual([]);
});
