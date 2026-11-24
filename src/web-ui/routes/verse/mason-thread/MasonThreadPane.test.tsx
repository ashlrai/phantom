import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { renderMobile, stubFetch } from '../mobile/mobile.test-support.js';
import { MasonThreadCard } from './MasonThreadCard.js';
import { MasonThreadPane } from './MasonThreadPane.js';

const READ = 'GET /api/verse/comms/mason-thread';
const base = { schema: 'phantom.mason.thread.v1', as_of: '2026-11-19T12:00:00.000Z', since: '2026-11-18T12:00:00.000Z', gaps: [], items: [] };

beforeEach(() => { evictAll(); setMutationToken('a'.repeat(64)); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); clearMutationToken(); });

describe('Mason thread reply box', () => {
  it('desktop: posts through the Leader inbox and clears the box', async () => {
    const net = stubFetch({ [READ]: base, 'POST /api/verse/leader/inbox': { ok: true } });
    renderMobile(<MasonThreadPane />);
    const box = await screen.findByRole('textbox', { name: 'Message the Leader' });
    fireEvent.change(box, { target: { value: 'ship it' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(box).toHaveProperty('value', ''));
    expect(net.posts()).toHaveLength(1);
    expect(net.posts()[0]?.url).toContain('/api/verse/leader/inbox');
    expect(net.posts()[0]?.body).toMatchObject({ text: 'ship it' });
  });

  it('desktop: keeps the words and says why when the inbox refuses', async () => {
    stubFetch({ [READ]: base, 'POST /api/verse/leader/inbox': () => new Response(JSON.stringify({ error: 'The inbox is full.' }), { status: 500, headers: { 'content-type': 'application/json' } }) });
    renderMobile(<MasonThreadPane />);
    const box = await screen.findByRole('textbox', { name: 'Message the Leader' });
    fireEvent.change(box, { target: { value: 'ship it' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Not sent.');
    expect(box).toHaveProperty('value', 'ship it');
  });

  it('phone card shows the thread without a second box (the Leader composer is the reply box)', async () => {
    stubFetch({ [READ]: base });
    renderMobile(<MasonThreadCard />);
    expect(await screen.findByText('Nothing yet.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
