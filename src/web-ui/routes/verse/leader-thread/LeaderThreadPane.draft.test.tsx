import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';
import { setLeaderDraft } from './leader-draft-store.js';
import { REPLY_DRAFT_KEY } from './reply-draft-model.js';

const inboxPath = '/api/verse/leader/inbox';

beforeEach(() => { evictAll(); window.localStorage.clear(); setMutationToken('a'.repeat(64)); });
afterEach(() => { vi.unstubAllGlobals(); clearMutationToken(); window.localStorage.clear(); });

function serve(post?: (url: string, body: Record<string, unknown>) => Response | undefined) {
  return stubSurfaceFetch({ routes: {
    '/api/verse/leader/thread': { messages: [msg({ id: 'one', text: 'Hello from the Leader.' })] },
    '/api/verse/leader/directives': { directives: [] },
  }, post });
}

async function open(strict = false) {
  const view = render(strict ? <StrictMode><LeaderThreadPane visible /></StrictMode> : <LeaderThreadPane visible />);
  await screen.findByText('Hello from the Leader.');
  return { view, box: screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Reply to the Leader' }) };
}

const kept = () => JSON.parse(window.localStorage.getItem(REPLY_DRAFT_KEY) ?? 'null') as { text: string; at: number } | null;
const keep = (text: string, at = Date.now() - 2 * 3_600_000) => window.localStorage.setItem(REPLY_DRAFT_KEY, JSON.stringify({ text, at }));

describe('Leader pane kept draft', () => {
  it('keeps what is typed and puts it back when the pane opens again', async () => {
    serve();
    const first = await open();
    expect(screen.queryByText(/Draft restored/)).toBeNull();
    fireEvent.change(first.box, { target: { value: 'Hold the release until the board is fixed' } });
    expect(kept()?.text).toBe('Hold the release until the board is fixed');
    first.view.unmount();

    const { box } = await open();
    expect(box).toHaveValue('Hold the release until the board is fixed');
    expect(screen.getByText(/Draft restored, last edited \d+s ago\. It is kept on this computer until you send it\./)).toBeInTheDocument();
  });

  it('restores under StrictMode without erasing the kept draft', async () => {
    serve();
    keep('survives a double mount');
    const { box } = await open(true);
    expect(box).toHaveValue('survives a double mount');
    expect(kept()?.text).toBe('survives a double mount');
    expect(screen.getByText(/Draft restored, last edited 2h ago/)).toBeInTheDocument();
  });

  it('leaves a kept draft alone when the pane opens empty-handed and stays empty', async () => {
    serve();
    const { box } = await open();
    keep('written in another window');
    fireEvent.change(box, { target: { value: '  ' } });
    fireEvent.change(box, { target: { value: '' } });
    expect(kept()?.text).toBe('written in another window');
  });

  it('drops the restored line once the draft is edited, and keeps the edit', async () => {
    serve();
    keep('first thought');
    const { box } = await open();
    fireEvent.change(box, { target: { value: 'first thought, revised' } });
    expect(screen.queryByText(/Draft restored/)).toBeNull();
    expect(kept()?.text).toBe('first thought, revised');
  });

  it('discards the draft from the box and from storage, and returns focus to the box', async () => {
    serve();
    keep('never mind');
    const { box } = await open();
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
    expect(box).toHaveValue('');
    expect(kept()).toBeNull();
    expect(box).toHaveFocus();
    expect(screen.queryByText(/Draft restored/)).toBeNull();
  });

  it('forgets the draft once it is sent', async () => {
    const net = serve();
    const { box } = await open();
    fireEvent.change(box, { target: { value: 'Send this one' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(net.posted).toContainEqual({ url: inboxPath, body: { source: 'Phantom desktop', text: 'Send this one' } }));
    await waitFor(() => expect(box).toHaveValue(''));
    expect(kept()).toBeNull();
  });

  it('still holds the draft after the server refuses the send', async () => {
    serve(url => url === inboxPath ? new Response(JSON.stringify({ error: 'The Leader is unavailable.' }), { status: 500 }) : undefined);
    const { box } = await open();
    fireEvent.change(box, { target: { value: 'Do not lose me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The Leader is unavailable.');
    expect(kept()?.text).toBe('Do not lose me');
  });

  it('puts text handed over from another pane after the restored draft', async () => {
    serve();
    keep('my own words');
    setLeaderDraft('Asked from the feed');
    const { box } = await open();
    expect(box).toHaveValue('my own words\n\nAsked from the feed');
    expect(kept()?.text).toBe('my own words\n\nAsked from the feed');
  });

  it('clears a copy of the draft that another window sent or discarded', async () => {
    serve();
    keep('same words in two windows');
    const { box } = await open();
    const oldValue = window.localStorage.getItem(REPLY_DRAFT_KEY);
    window.localStorage.removeItem(REPLY_DRAFT_KEY);
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: REPLY_DRAFT_KEY, oldValue, newValue: null })); });
    expect(box).toHaveValue('');
    expect(screen.getByText('This draft was sent or discarded in another window, so it was cleared here.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/another window/)).toBeNull();
  });

  it('keeps its own different draft when another window clears the kept one', async () => {
    serve();
    const { box } = await open();
    fireEvent.change(box, { target: { value: 'my words here' } });
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: REPLY_DRAFT_KEY, oldValue: JSON.stringify({ text: 'other words', at: 1 }), newValue: null })); });
    expect(box).toHaveValue('my words here');
  });

  it('says so when the browser cannot keep the draft', async () => {
    serve();
    const { box } = await open();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    fireEvent.change(box, { target: { value: 'typed with storage full' } });
    expect(screen.getByText(/This draft is not being kept: browser storage is unavailable/)).toBeInTheDocument();
    expect(box).toHaveValue('typed with storage full');
  });

  it('counts down the room left near the limit and says when the box is full', async () => {
    serve();
    const { box } = await open();
    fireEvent.change(box, { target: { value: 'x'.repeat(5700) } });
    expect(screen.getByText('5,700 of 6,000 characters, 300 left.')).toBeInTheDocument();
    fireEvent.change(box, { target: { value: 'x'.repeat(6000) } });
    expect(screen.getByText(/6,000 of 6,000 characters\. The box is full/)).toBeInTheDocument();
    fireEvent.change(box, { target: { value: 'short again' } });
    expect(screen.queryByText(/of 6,000 characters/)).toBeNull();
  });
});
