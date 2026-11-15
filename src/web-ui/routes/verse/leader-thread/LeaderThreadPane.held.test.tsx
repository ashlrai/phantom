import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';

const threadPath = '/api/verse/leader/thread';
const inboxPath = '/api/verse/leader/inbox';
const heldBody = { ok: false, status: 'drafted', reason: 'Communication approval is not confirmed.' };

beforeEach(() => { evictAll(); setMutationToken('a'.repeat(64)); });
afterEach(() => { vi.unstubAllGlobals(); clearMutationToken(); });

function serve(post: (url: string, body: Record<string, unknown>) => Response | undefined) {
  return stubSurfaceFetch({ routes: {
    [threadPath]: { messages: [msg({ id: 'one', text: 'Hello from the Leader.' })] },
    '/api/verse/leader/directives': { directives: [] },
  }, post });
}
const held = (url: string) => url === inboxPath ? new Response(JSON.stringify(heldBody), { status: 403 }) : undefined;

async function sendDraft(text: string) {
  render(<LeaderThreadPane visible />);
  await screen.findByText('Hello from the Leader.');
  const input = screen.getByRole('textbox', { name: 'Reply to the Leader' });
  fireEvent.change(input, { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  return input;
}

describe('Leader thread pane held inbox', () => {
  it('explains the hold, shows the file and line, and keeps the draft', async () => {
    serve(held);
    const input = await sendDraft('Keep me');
    const note = await screen.findByText(/Held: comms approval is not confirmed, so this did not reach MASON-INBOX\./);
    expect(note).toHaveTextContent('Only Mason edits this file');
    expect(screen.getByText('~/.ashlr/comms.toml')).toBeTruthy();
    expect(screen.getByText('confirmedByMason = true')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(input).toHaveValue('Keep me');
  });

  it('sends the same text to the thread and clears the draft', async () => {
    const net = serve(url => url === threadPath ? new Response(JSON.stringify({ message: {}, reply: null }), { status: 200 }) : held(url));
    const input = await sendDraft('Reach the Leader');
    fireEvent.click(await screen.findByRole('button', { name: 'Send to the Leader thread instead' }));
    await waitFor(() => expect(net.posted).toContainEqual({ url: threadPath, body: { text: 'Reach the Leader' } }));
    await waitFor(() => expect(input).toHaveValue(''));
    await waitFor(() => expect(screen.queryByText(/Held: comms approval/)).toBeNull());
  });

  it('keeps the draft and shows the reason when the thread send fails', async () => {
    serve(url => url === threadPath ? new Response(JSON.stringify({ error: 'Thread is down.' }), { status: 500 }) : held(url));
    const input = await sendDraft('Still mine');
    fireEvent.click(await screen.findByRole('button', { name: 'Send to the Leader thread instead' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Thread is down.');
    expect(input).toHaveValue('Still mine');
  });

  it.each([
    [403, { error: 'Forbidden.' }, 'Forbidden.'],
    [500, { error: 'Broken.' }, 'Broken.'],
    [500, heldBody, 'Communication approval is not confirmed.'],
  ])('keeps the old failure text for a non-held %s', async (status, body, text) => {
    serve(url => url === inboxPath ? new Response(JSON.stringify(body), { status }) : undefined);
    await sendDraft('Plain');
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(screen.queryByText(/Held: comms approval/)).toBeNull();
  });
});
