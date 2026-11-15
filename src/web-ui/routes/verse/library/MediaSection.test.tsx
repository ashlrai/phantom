import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { MediaSection } from './MediaSection.js';

vi.mock('../../../data/auth-store.js', async (original) => ({ ...await original<object>(), getMutationToken: () => 'test-token' }));
vi.mock('../../../data/remote-mode.js', () => ({ isRemoteMobileMode: () => false }));
const item = (name: string) => ({ name, type: 'image/png', bytes: 8, modifiedAt: new Date().toISOString() });
beforeEach(() => { evictAll(); vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} })); });
afterEach(() => { vi.unstubAllGlobals(); });
it('renders authenticated thumbnails', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/attachments')
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
