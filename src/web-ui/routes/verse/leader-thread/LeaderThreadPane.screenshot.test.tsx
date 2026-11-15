import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';

const NAME = '0123456789abcdef.png';
const ROUTE = `/api/verse/leader/attachment/${NAME}`;
const MARKER = `[screenshot: /tmp/fake-runs/inbox-attachments/${NAME}]`;

beforeEach(() => {
  evictAll();
  setMutationToken('a'.repeat(64));
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:shot'), revokeObjectURL: vi.fn() }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); clearMutationToken(); });

function serve(attachment: () => Response, messages = [
  msg({ id: 'one', from: 'mason', text: `look at this\n${MARKER}` }),
]) {
  return stubSurfaceFetch({ routes: {
    '/api/verse/leader/thread': { messages },
    '/api/verse/fleet/runs': { inbox: [] },
    '/api/verse/leader/directives': { directives: [] },
    [ROUTE]: attachment,
  } });
}

describe('Leader thread screenshot markers', () => {
  it('renders a Mason marker as an image fetched from the attachment route, text intact', async () => {
    const net = serve(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    render(<LeaderThreadPane visible />);
    const img = await screen.findByAltText('Screenshot you sent');
    expect(img).toHaveAttribute('src', 'blob:shot');
    const call = net.fetchMock.mock.calls.find(([url]) => url === ROUTE);
    expect(call?.[1]?.headers).toMatchObject({ 'x-ashlr-token': 'a'.repeat(64) });
    expect(screen.getByText('look at this')).toBeInTheDocument();
    expect(screen.queryByText(MARKER, { exact: false })).toBeNull();
  });

  it('opens the full-size image in a dialog on click', async () => {
    serve(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    render(<LeaderThreadPane visible />);
    const img = await screen.findByAltText('Screenshot you sent');
    fireEvent.click(img);
    const dialog = await screen.findByRole('dialog', { name: 'Screenshot you sent' });
    expect(dialog.querySelector('img')).toHaveAttribute('src', 'blob:shot');
  });

  it('keeps the raw marker plus "(image unavailable)" when the read is refused', async () => {
    serve(() => new Response(JSON.stringify({ error: 'not found' }), { status: 404 }));
    render(<LeaderThreadPane visible />);
    expect(await screen.findByText(`${MARKER} (image unavailable)`)).toBeInTheDocument();
    expect(screen.queryByAltText('Screenshot you sent')).toBeNull();
  });

  it('keeps the raw marker when no mutation token is held', async () => {
    clearMutationToken();
    const net = serve(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    render(<LeaderThreadPane visible />);
    expect(await screen.findByText(`${MARKER} (image unavailable)`)).toBeInTheDocument();
    expect(net.fetchMock.mock.calls.some(([url]) => url === ROUTE)).toBe(false);
  });

  it('leaves a Leader line\'s identical bracket text alone', async () => {
    serve(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }), [
      msg({ id: 'one', text: `not yours\n${MARKER}` }),
    ]);
    render(<LeaderThreadPane visible />);
    const log = screen.getByRole('log', { name: 'Conversation with the Leader' });
    await within(log).findByText(/not yours/);
    // A Leader line renders as markdown: the marker stays plain text.
    expect(log.textContent).toContain(MARKER);
    expect(screen.queryByAltText('Screenshot you sent')).toBeNull();
  });
});
