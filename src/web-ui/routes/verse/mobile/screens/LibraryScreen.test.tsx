import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../../data/cache.js';
import { LibraryPane } from '../../library/LibraryPane.js';
import { libraryItemsQuery, libraryText } from '../../library/library-items.js';
import { formatMobileHash, parseMobileHash, tabOf } from '../mobile-router.js';
import { json, renderMobile, stubFetch } from '../mobile.test-support.js';
import { LibraryScreen } from './LibraryScreen.js';

const at = '2026-11-17T01:00:00Z';
const file = { name: 'VISION.md', size: 20, modifiedAt: at, preview: '<b>Future</b>' };
const routes = (over: Record<string, unknown> = {}) => stubFetch({
  'GET /api/verse/library/pins': { v: 1, pins: [] },
  'GET /api/verse/fleet/library-files': { v: 1, observedAt: at, files: [] },
  'GET /api/verse/leader/attachment-metadata': { state: 'ok', items: [] },
  'GET /api/verse/fleet/handoffs': { v: 1, observedAt: at, handoffs: [] },
  'GET /api/verse/cos/memory': { v: 1, entries: [] },
  'GET /api/verse/sessions': [],
  'GET /api/verse/agent-bus': { v: 1, status: 'ok', nextCursor: 0, messages: [] },
  'GET /api/verse/agent-bus/status': { v: 1, source: 'missing', retainedCount: 0, retainedBytes: 0, liveCount: 0, expiredCount: 0, maxMessages: 50, maxBytes: 5000 },
  ...over,
});
beforeEach(() => evictAll());
afterEach(() => vi.unstubAllGlobals());

it('has a primary route and shows a genuinely empty Library', async () => {
  routes();
  renderMobile(<LibraryScreen />);
  expect(await screen.findByText('Your Library is empty.')).toBeInTheDocument();
  expect(parseMobileHash(formatMobileHash({ screen: 'library' }))).toEqual({ screen: 'library' });
  expect(tabOf({ screen: 'library' })).toBe('library');
});

it('shows the same one file as desktop, opens as text and searches locally', async () => {
  const fetches = routes({ 'GET /api/verse/fleet/library-files': { v: 1, observedAt: at, files: [file] } });
  const desktop = renderMobile(<LibraryPane />);
  expect(await screen.findByRole('button', { name: /Vision/ })).toHaveTextContent(file.preview);
  desktop.unmount();
  const { container } = renderMobile(<LibraryScreen />);
  const title = await screen.findByText('Vision');
  const summary = title.closest('summary')!;
  fireEvent.click(summary);
  expect(summary.parentElement).toHaveAttribute('open');
  expect(screen.getByText(file.preview)).toBeInTheDocument();
  expect(container.querySelector('b')).toBeNull();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } });
  expect(screen.getByText('No matching items.')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'future' } });
  expect(screen.getByText('Vision')).toBeInTheDocument();
  expect(fetches.posts()).toEqual([]);
});

it('retains unreadable item titles and distinguishes source failure from empty', async () => {
  routes({
    'GET /api/verse/fleet/library-files': { v: 1, observedAt: at, files: [{ ...file, preview: '', unavailable: true }] },
    'GET /api/verse/fleet/handoffs': () => json({ error: 'private diagnostic' }, 503),
  });
  renderMobile(<LibraryScreen />);
  const title = await screen.findByText('Vision');
  expect(title.closest('summary')).toHaveTextContent('unavailable');
  expect(screen.getByText('Context').closest('summary')).toHaveTextContent('unavailable');
  expect(screen.queryByText('private diagnostic')).not.toBeInTheDocument();
  expect(screen.queryByText('Your Library is empty.')).not.toBeInTheDocument();
});

it('sorts mixed desktop sources newest first, keeps media metadata and unreadable project memory', async () => {
  routes({
    'GET /api/verse/fleet/library-files': { v: 1, observedAt: at, files: [file] },
    'GET /api/verse/cos/memory': { v: 1, entries: [{ id: 'm1', kind: 'fact', source: 'owner', updated: '2026-11-17T02:00:00Z', text: 'Remember this' }] },
    'GET /api/verse/fleet/handoffs': { v: 1, observedAt: at, handoffs: [{ folder: 'agent', name: 'Notes.md', size: 2, modifiedAt: '2026-11-17T03:00:00Z', preview: 'Context text' }] },
    'GET /api/verse/leader/attachment-metadata': { state: 'ok', items: [{ name: '0123456789abcdef.png', bytes: 10, type: 'image/png', modifiedAt: '2026-11-17T04:00:00Z' }] },
    'GET /api/verse/sessions': [{ projectPath: '/tmp/project', createdAt: at, updatedAt: at }],
    'GET /api/verse/memory': () => json({}, 403),
  });
  renderMobile(<LibraryScreen />);
  const list = await screen.findByRole('list', { name: 'Library items' });
  const titles = within(list).getAllByRole('listitem').map(row => row.querySelector('strong')?.textContent);
  expect(titles.slice(0, 3)).toEqual(['0123456789abcdef.png', 'agent: Notes.md', 'Remember this']);
  expect(screen.getByText('project memory').closest('summary')).toHaveTextContent('unavailable');
  expect(list.querySelector('img')).toBeNull();
});

it('redacts assignments before search and refuses arbitrary agent-body objects', async () => {
  const now = Date.now();
  routes({
    'GET /api/verse/agent-bus/status': { v: 1, source: 'available', retainedCount: 1, retainedBytes: 10, liveCount: 1, expiredCount: 0, maxMessages: 50, maxBytes: 5000 },
    'GET /api/verse/agent-bus': { v: 1, status: 'ok', nextCursor: 1, messages: [{ cursor: 1, receivedAt: now, envelope: { id: 'b1', from: 'worker', to: 'leader', priority: 'P2', ttl: 5000, body: { env: { EXAMPLE: 'private-value' } } } }] },
  });
  const rows = await libraryItemsQuery.fetch();
  expect(rows).toEqual([{ id: 'Agent message:b1', kind: 'Agent message', title: 'worker → leader', at: now, content: null }]);
  for (const text of ['export lower_case=value', '_PRIVATE=value', '{"env":{"lower_case":"value"}}', 'EXAMPLE=private-value', '{"EXAMPLE":"private-value"}', 'EXAMPLE="multi\nline"']) expect(libraryText(text)).toBe('[REDACTED]');
});

it('uses paired-cookie reads for pins and project memory without local tokens', async () => {
  const meta = document.createElement('meta');
  meta.name = 'ashlr-remote-gateway'; meta.content = 'v1'; document.head.append(meta);
  try {
    const fetches = routes({
      'GET /api/verse/library/pins': { v: 1, pins: [{ id: 'pin1', kind: 'bus', ref: 'old-message', title: 'Earlier decision', pinnedAt: at }] },
      'GET /api/verse/sessions': [{ projectPath: '/tmp/project', createdAt: at, updatedAt: at }],
      'GET /api/verse/memory': { content: 'Shared context', updatedAt: at },
    });
    const rows = await libraryItemsQuery.fetch();
    expect(rows.map(row => row.title)).toEqual(['project memory', 'Earlier decision']);
    expect(rows[0]?.content).toBe('Shared context');
    expect(fetches.calls.every(call => !('x-ashlr-token' in call.headers) && !('x-ashlr-read-client' in call.headers))).toBe(true);
  } finally { meta.remove(); }
});
