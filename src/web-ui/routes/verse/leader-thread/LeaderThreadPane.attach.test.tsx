import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { ATTACHMENT_PATH } from '../leader/composer-attachment.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';

const PATH = '/tmp/fake-runs/inbox-attachments/0123456789abcdef.png';
const MARKER = `[screenshot: ${PATH}]`;

beforeEach(() => {
  evictAll();
  setMutationToken('a'.repeat(64));
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:local'), revokeObjectURL: vi.fn() }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); clearMutationToken(); });

describe('Leader pane reply box screenshots', () => {
  it('sends a pasted screenshot as its line in the inbox message, then clears the chip', async () => {
    const net = stubSurfaceFetch({ routes: {
      '/api/verse/leader/thread': { messages: [] },
      '/api/verse/fleet/runs': { inbox: [] },
      '/api/verse/leader/directives': { directives: [] },
    } });
    // The attachment POST carries the image bytes, not JSON; everything else goes to the shared stub.
    const uploads: File[] = [], shared = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input !== ATTACHMENT_PATH) return shared(input, init);
      uploads.push(init!.body as File);
      return new Response(JSON.stringify({ path: PATH, sha256: 'x', bytes: 3, type: 'image/png' }), { status: 200 });
    }));
    render(<LeaderThreadPane visible />);
    const box = screen.getByLabelText<HTMLTextAreaElement>('Reply to the Leader');
    fireEvent.change(box, { target: { value: 'the board looks wrong' } });
    const file = new File([new Uint8Array(3)], 'board.png', { type: 'image/png' });
    fireEvent.paste(box, { clipboardData: { files: [file], items: [] } });
    await waitFor(() => expect(box.value).toBe(`the board looks wrong\n${MARKER}`));
    expect(uploads).toEqual([file]);
    expect(screen.getByRole('list', { name: 'Attached screenshots' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(net.posted.some(post => post.url === '/api/verse/leader/inbox')).toBe(true));
    expect(net.posted.find(post => post.url === '/api/verse/leader/inbox')!.body).toMatchObject({ text: `the board looks wrong\n${MARKER}` });
    await waitFor(() => expect(box.value).toBe(''));
    expect(screen.queryByRole('list', { name: 'Attached screenshots' })).toBeNull();
  });
});
