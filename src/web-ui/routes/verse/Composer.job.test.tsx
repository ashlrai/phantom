import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../data/auth-store.js';
import { evictAll } from '../../data/cache.js';
import { Composer, type ComposerProps } from './Composer.js';
import { CLAUDE_SEAT } from './fixtures.test-support.js';

const path = '/api/verse/fleet/live/drop-jobs';
beforeEach(() => { evictAll(); localStorage.clear(); setMutationToken('fixture-token'); });
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

it('posts a job command from the composer and keeps focus', async () => {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === path && init?.method === 'POST') return Response.json({ v: 1, status: 'written', bytes: 321 }, { status: 201 });
    return Response.json({}, { status: 404 });
  });
  vi.stubGlobal('fetch', fetcher);
  const props: ComposerProps = { seats: [CLAUDE_SEAT], seat: { seatId: 'claude-main', model: 'claude-opus-5' }, engine: 'claude', running: false, disabled: false, locked: false, onSend: vi.fn(), onStop: vi.fn(), onSeatChange: vi.fn() };
  render(<Composer {...props} />);
  const box = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(box, { target: { value: '/jo' } });
  fireEvent.click(screen.getByText('/job'));
  expect(box).toHaveValue('/job ');
  fireEvent.change(box, { target: { value: '/job lane=devin tier=work fix the X' } });
  fireEvent.keyDown(box, { key: 'Enter' });
  await screen.findByText(/^Dropped job RQ-PHX-MASONFIXTHEX[A-Z0-9]+ for devin\/work · 321 bytes$/);
  const posts = fetcher.mock.calls.filter(([url, init]) => String(url) === path && init?.method === 'POST');
  expect(posts).toHaveLength(1);
  const envelope = JSON.parse(String(posts[0]![1]!.body));
  expect(envelope).toMatchObject({ lane: 'devin', tier: 'work', body: expect.stringContaining('fix the X') });
  expect(envelope.id).toMatch(/^MASONFIXTHEX[A-Z0-9]+$/);
  expect(box).toHaveValue('');
  await waitFor(() => expect(box).toHaveFocus());
  expect(props.onSend).not.toHaveBeenCalled();
});

it('shows the lock message and posts nothing when actions are locked', async () => {
  clearMutationToken();
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({}, { status: 404 }));
  vi.stubGlobal('fetch', fetcher);
  const onSend = vi.fn();
  render(<Composer seats={[CLAUDE_SEAT]} seat={{ seatId: 'claude-main', model: 'claude-opus-5' }} engine="claude" running={false} disabled={false} locked={false} onSend={onSend} onStop={vi.fn()} onSeatChange={vi.fn()} />);
  const box = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(box, { target: { value: '/job hello' } });
  fireEvent.keyDown(box, { key: 'Enter' });
  await screen.findByText('Unlock actions with the mutation token before chatting.');
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  expect(box).toHaveValue('/job hello');
  expect(onSend).not.toHaveBeenCalled();
});
