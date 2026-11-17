import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { MediaSection } from './MediaSection.js';

vi.mock('../../../data/remote-mode.js', () => ({ isRemoteMobileMode: () => false }));
const item = (name: string) => ({ name, type: 'image/png', bytes: 8, modifiedAt: new Date().toISOString() });
beforeEach(() => { setMutationToken('a'.repeat(64)); evictAll(); vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} })); });
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); });
it('renders authenticated thumbnails', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/attachment-metadata')
    ? new Response(JSON.stringify({ state: 'ok', items: [item('0000000000000001.png'), item('0000000000000002.png')] }))
    : new Response(new Blob(['fake']))));
  render(<MediaSection visible />);
  expect(await screen.findAllByAltText('Screenshot you sent')).toHaveLength(2);
  expect(screen.getAllByText(/8 B/)).toHaveLength(2);
});
it('shows the empty state', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ state: 'ok', items: [] }))));
  render(<MediaSection visible />);
  expect(await screen.findByText('No screenshots yet. Paste one into the Leader box.')).toBeInTheDocument();
});
it('shows an error', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
  render(<MediaSection visible />);
  expect(await screen.findByText('Screenshots are unavailable right now.')).toBeInTheDocument();
});

it('loads metadata while locked and retries bytes after unlocking', async () => {
  clearMutationToken();
  const fetchMock = vi.fn(async (url: string) => url.endsWith('/attachment-metadata')
    ? new Response(JSON.stringify({ state: 'ok', items: [item('0000000000000001.png')] }))
    : new Response(new Blob(['fake'])));
  vi.stubGlobal('fetch', fetchMock);
  render(<MediaSection visible />);
  await screen.findByText(/image unavailable/);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  act(() => setMutationToken('a'.repeat(64)));
  expect(await screen.findByAltText('Screenshot you sent')).toBeInTheDocument();
  act(() => clearMutationToken());
  expect(await screen.findByText(/image unavailable/)).toBeInTheDocument();
  expect(screen.queryByAltText('Screenshot you sent')).not.toBeInTheDocument();
});
