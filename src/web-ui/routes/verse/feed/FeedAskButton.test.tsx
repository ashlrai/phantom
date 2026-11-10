import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { setLeaderDraft, subscribeLeaderDraft, takeLeaderDraft } from '../leader-thread/leader-draft-store.js';
import { LeaderThreadPane } from '../leader-thread/LeaderThreadPane.js';
import { resetHomeChoice, setHomeChoice, useHomeView } from '../shell/home-view-store.js';
import { FeedAskButton } from './FeedAskButton.js';
import type { FeedItem } from './feed-model.js';

const item: FeedItem = { id: 'alert:1', at: '2026-01-01T00:00:00Z', kind: 'alert', title: 'Disk is filling', href: 'https://example.com/x' };

function View() { return <p data-testid="view">{useHomeView().view}</p>; }

beforeEach(() => { localStorage.clear(); resetHomeChoice(); takeLeaderDraft(); setHomeChoice('feed'); evictAll(); setMutationToken('a'.repeat(64)); });
afterEach(() => { vi.unstubAllGlobals(); clearMutationToken(); });

describe('FeedAskButton', () => {
  it('sets the draft and switches home to the Leader thread', () => {
    render(<><FeedAskButton item={item} /><View /></>);
    expect(screen.getByTestId('view')).toHaveTextContent('feed');
    fireEvent.click(screen.getByRole('button', { name: 'Ask Leader about Disk is filling' }));
    expect(screen.getByTestId('view')).toHaveTextContent('leader');
    expect(takeLeaderDraft()).toBe('About: Alert "Disk is filling" (https://example.com/x)\n\n');
  });
  it('notifies a mounted composer', () => {
    let calls = 0;
    const off = subscribeLeaderDraft(() => { calls += 1; });
    render(<FeedAskButton item={item} />);
    fireEvent.click(screen.getByRole('button'));
    off();
    expect(calls).toBe(1);
  });
});

const serve = () => stubSurfaceFetch({ routes: {
  '/api/verse/leader/thread': { messages: [msg({ id: 'one', text: 'Hello from the Leader.' })] },
  '/api/verse/leader/directives': { directives: [] },
} });

describe('Leader composer draft handoff', () => {
  it('shows a draft set before mount, focused, and sends nothing until Send', async () => {
    setLeaderDraft('About: Alert "Disk"\n\n');
    const net = serve();
    render(<LeaderThreadPane visible />);
    const input = await screen.findByRole('textbox', { name: 'Reply to the Leader' });
    expect(input).toHaveValue('About: Alert "Disk"\n\n');
    expect(input).toHaveFocus();
    expect(net.posted).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(net.posted).toHaveLength(1));
  });
  it('takes a draft set while mounted and keeps what Mason already typed', async () => {
    serve();
    render(<LeaderThreadPane visible />);
    const input = await screen.findByRole('textbox', { name: 'Reply to the Leader' });
    fireEvent.change(input, { target: { value: 'mine' } });
    act(() => setLeaderDraft('About: Merge "x"\n\n'));
    expect(input).toHaveValue('mine\n\nAbout: Merge "x"\n\n');
    expect(takeLeaderDraft()).toBe('');
  });
});
