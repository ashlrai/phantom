import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../data/auth-store.js';
import { evictAll } from '../../data/cache.js';
import { Composer, type ComposerProps } from './Composer.js';
import { CLAUDE_SEAT } from './fixtures.test-support.js';

const path = '/api/verse/agent-bus';
beforeEach(() => { evictAll(); localStorage.clear(); setMutationToken('fixture-token'); });
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

it('posts a bus command from the composer and keeps focus', async () => {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === path && init?.method === 'POST') return Response.json({ v: 1, status: 'posted' }, { status: 201 });
    return Response.json({}, { status: 404 });
  });
  vi.stubGlobal('fetch', fetcher);
  const props: ComposerProps = { seats: [CLAUDE_SEAT], seat: { seatId: 'claude-main', model: 'claude-opus-5' }, engine: 'claude', running: false, disabled: false, locked: false, onSend: vi.fn(), onStop: vi.fn(), onSeatChange: vi.fn() };
  render(<Composer {...props} />);
  const box = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(box, { target: { value: '/bu' } });
  fireEvent.click(screen.getByText('/bus'));
  expect(box).toHaveValue('/bus ');
  fireEvent.change(box, { target: { value: '/bus leaders ship 3.30.0 today' } });
  fireEvent.keyDown(box, { key: 'Enter' });
  await screen.findByText(/^Posted to leaders on the bus · mason-composer-/);
  const posts = fetcher.mock.calls.filter(([url, init]) => String(url) === path && init?.method === 'POST');
  expect(posts).toHaveLength(1);
  const envelope = JSON.parse(String(posts[0]![1]!.body));
  expect(envelope).toMatchObject({ from: 'mason', to: 'leaders', priority: 'P1', ttl: 3600, body: { text: 'ship 3.30.0 today', source: 'Phantom desktop composer' } });
  expect(box).toHaveValue('');
  await waitFor(() => expect(box).toHaveFocus());
  expect(props.onSend).not.toHaveBeenCalled();
});
