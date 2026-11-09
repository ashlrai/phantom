import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { LibraryPane } from './LibraryPane.js';

const navigation = vi.hoisted(() => ({ openChat: vi.fn() }));
vi.mock('../command/nav.js', () => navigation);
const dock = vi.hoisted(() => ({ openDockPane: vi.fn() }));
vi.mock('../dock/dock-store.js', () => dock);

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const session = (id: string, projectPath: string, updatedAt: string) => ({ id, title: id, projectPath, createdAt: updatedAt, updatedAt });
const sessions = [
  session('s1', '/tmp/fake-project/alpha', '2026-01-02T00:00:00Z'),
  session('s2', '/tmp/fake-project/beta', '2026-01-01T00:00:00Z'),
];
const memoryFor = (content: string, extra: object = {}) => ({ projectPath: '', enabled: true, content, bytes: content.length, updatedAt: null, files: [], ...extra });
const hit = { sessionId: 's9', title: 'Retry policy', projectPath: '/tmp/fake-project/alpha', engine: 'claude', seq: 1, at: '2026-01-01T00:00:00Z', kind: 'user', snippet: 'we chose backoff', score: 1 };

function stub(search: (url: string) => Response = () => json({ query: 'x', hits: [hit], scannedSessions: 1, truncated: false })) {
  return stubSurfaceFetch({
    routes: {
      '/api/verse/sessions': sessions,
      '/api/verse/memory': (url: string) => {
        const path = new URL(url, 'http://x').searchParams.get('projectPath');
        if (path?.endsWith('beta')) return json({ error: 'path is not a directory' }, 400);
        return json(memoryFor('# Alpha notes\n<b>bold</b> line', { contentSanitized: true }));
      },
      '/api/verse/search': search,
    },
  });
}

beforeEach(() => { evictAll(); navigation.openChat.mockClear(); dock.openDockPane.mockClear(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('LibraryPane', () => {
  it('shows one project failing on its own card while another renders, as plain text', async () => {
    stub();
    const { container } = render(<LibraryPane visible />);
    expect(await screen.findByText('# Alpha notes')).toBeInTheDocument();
    expect(screen.getByText('<b>bold</b> line')).toBeInTheDocument();
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByText('Some text was redacted.')).toBeInTheDocument();
    expect(await screen.findByText(/Could not read this project's memory/)).toBeInTheDocument();
  });

  it('sends no request for a one-character query', async () => {
    const { fetchMock } = stub();
    render(<LibraryPane visible />);
    await screen.findByText('# Alpha notes');
    fireEvent.change(screen.getByLabelText('Search past chats'), { target: { value: 'a' } });
    await new Promise(r => setTimeout(r, 450));
    expect(fetchMock.mock.calls.some(c => String(c[0]).startsWith('/api/verse/search'))).toBe(false);
  });

  it('shows the server sentence on a 400 and opens a result on click', async () => {
    let refuse = true;
    stub(() => (refuse ? json({ error: 'q must be at least 2 characters' }, 400) : json({ query: 'ba', hits: [hit], scannedSessions: 1, truncated: false })));
    render(<LibraryPane visible />);
    const box = screen.getByLabelText('Search past chats');
    fireEvent.change(box, { target: { value: 'ab' } });
    expect(await screen.findByText('q must be at least 2 characters', {}, { timeout: 3000 })).toBeInTheDocument();
    refuse = false;
    fireEvent.change(box, { target: { value: 'back' } });
    const result = await screen.findByRole('button', { name: /Retry policy/ }, { timeout: 3000 });
    expect(result).toHaveTextContent('we chose backoff');
    fireEvent.click(result);
    expect(navigation.openChat).toHaveBeenCalledWith('s9');
  });

  it('opens the bus and the Leader thread', async () => {
    stub();
    render(<LibraryPane visible />);
    fireEvent.click(screen.getByRole('button', { name: 'Open the bus' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open the Leader thread' }));
    expect(dock.openDockPane.mock.calls).toEqual([['fleet-bus'], ['leader-thread']]);
  });
});
