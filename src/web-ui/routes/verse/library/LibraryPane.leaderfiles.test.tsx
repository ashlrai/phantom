import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { LibraryPane } from './LibraryPane.js';

vi.mock('../command/nav.js', () => ({ openChat: vi.fn() }));
vi.mock('../dock/dock-store.js', () => ({ openDockPane: vi.fn() }));

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const LONG = `${'word '.repeat(46)}END`.slice(0, 240);
const ok = (files: unknown[], extra: Record<string, unknown> = {}) => ({ v: 1, observedAt: new Date().toISOString(), files, ...extra });

function stub(library: () => Response) {
  stubSurfaceFetch({ routes: {
    '/api/verse/sessions': [],
    '/api/verse/agent-bus/status': () => json({ v: 1, source: 'missing', retainedCount: null, retainedBytes: null, liveCount: null, expiredCount: null, maxMessages: 1, maxBytes: 1 }),
    '/api/verse/agent-bus': () => json({ v: 1, status: 'ok', messages: [], nextCursor: 1 }),
    '/api/verse/fleet/library-files': library,
  } });
}

beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('LibraryPane leader files', () => {
  it('lists newest first with label, age, size, and expands the preview on click', async () => {
    stub(() => json(ok([
      { name: 'VISION.md', size: 2048, modifiedAt: ago(2 * 3_600_000), preview: LONG },
      { name: 'drafts/note.md', size: 10, modifiedAt: ago(60_000), preview: '<b>hi</b>' },
    ])));
    const { container } = render(<LibraryPane visible />);
    const list = await screen.findByRole('list', { name: 'Leader files list' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Draft: note');
    expect(rows[0]).toHaveTextContent('1 min ago');
    expect(rows[0]).toHaveTextContent('10 B');
    expect(screen.getByText('<b>hi</b>')).toBeInTheDocument();
    expect(container.querySelector('b')).toBeNull();
    expect(rows[1]).toHaveTextContent('Vision');
    expect(rows[1]).toHaveTextContent('2 h ago');
    expect(rows[1]).toHaveTextContent('2.0 KB');
    const button = within(rows[1]).getByRole('button');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(rows[1]).not.toHaveTextContent(LONG);
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(rows[1].textContent).toContain(LONG);
  });

  it('says plainly when the read failed', async () => {
    stub(() => json({ error: 'boom' }, 500));
    render(<LibraryPane visible />);
    expect(await screen.findByText("Could not read the Leader's files")).toBeInTheDocument();
  });

  it('treats a malformed body as an error, not an empty list', async () => {
    stub(() => json(ok([{ name: '/abs/VISION.md', size: 1, modifiedAt: ago(1000), preview: '' }])));
    render(<LibraryPane visible />);
    expect(await screen.findByText("Could not read the Leader's files")).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Leader files list' })).toBeNull();
  });

  it('shows the unavailable state', async () => {
    stub(() => json(ok([], { state: 'unavailable' })));
    render(<LibraryPane visible />);
    expect(await screen.findByText(/files are unavailable right now/)).toBeInTheDocument();
  });

  it('shows the absent state', async () => {
    stub(() => json(ok([], { state: 'absent' })));
    render(<LibraryPane visible />);
    expect(await screen.findByText('The Leader has no working files yet.')).toBeInTheDocument();
  });
});
