import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer } from './Composer.js';
import { CLAUDE_SEAT } from './fixtures.test-support.js';
import { clearMutationToken, setMutationToken } from '../../data/auth-store.js';
import { saveAutoPref } from './multimodel/useAutoSeat.js';

// Model an unresolved lazy bar: no interceptor has registered yet.
vi.mock('./multimodel/MultiModelBar.js', () => ({ default: () => null }));
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })));
});
afterEach(() => { localStorage.clear(); clearMutationToken(); vi.unstubAllGlobals(); });

function mount(running = false) {
  const onSend = vi.fn(async () => true);
  render(<Composer sessionId="lazy-chat" seats={[CLAUDE_SEAT]} seat={{ seatId: CLAUDE_SEAT.id, model: CLAUDE_SEAT.models[0]!.id }}
    engine="claude" running={running} disabled={false} locked={false} onSend={onSend} onStop={vi.fn()} onSeatChange={vi.fn()} />);
  const box = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(box, { target: { value: 'Keep this draft' } });
  fireEvent.keyDown(box, { key: 'Enter', code: 'Enter' });
  return { box, onSend };
}

describe('Composer lazy routing admission', () => {
  it.each(['default', 'auto', 'cheap-first', 'manager'] as const)('preserves %s draft without a loaded interceptor', async (pref) => {
    if (pref !== 'default') saveAutoPref('lazy-chat', pref);
    const { box, onSend } = mount();
    await screen.findByText('Routing is still loading. Your draft is preserved; send again when it is ready.');
    expect(onSend).not.toHaveBeenCalled();
    expect(box).toHaveValue('Keep this draft');
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.some(([url]) => String(url).endsWith('/turns'))).toBe(false);
  });
  it('holds Delegate while a native turn runs and its interceptor has not registered', async () => {
    saveAutoPref('lazy-chat', 'manager');
    const { box, onSend } = mount(true);
    await screen.findByText('Routing is still loading. Your draft is preserved; send again when it is ready.');
    expect(onSend).not.toHaveBeenCalled();
    expect(box).toHaveValue('Keep this draft');
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.some(([url]) => /\/(turns|queue|outcomes\/interactive)$/.test(String(url)))).toBe(false);
  });
  it.each(['auto', 'cheap-first'] as const)('keeps running %s follow-ups on the native queue while the bar loads', async (pref) => {
    saveAutoPref('lazy-chat', pref);
    setMutationToken('a'.repeat(64));
    const posts: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/verse/queue/')) {
        if (init?.method === 'POST') posts.push(String(init.body));
        return Response.json({ sessionId: 'lazy-chat', items: [], held: false, heldReason: null });
      }
      return new Response('unsupported', { status: 404 });
    }));
    const { box, onSend } = mount(true);
    await screen.findByRole('button', { name: 'Queue this message — it sends when the turn ends' });
    fireEvent.keyDown(box, { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(JSON.parse(posts[0]!)).toMatchObject({ text: 'Keep this draft' });
    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() => expect(box).toHaveValue(''));
  });
  it('allows an explicit Manual send while the lazy bar loads', async () => {
    saveAutoPref('lazy-chat', 'off');
    const { box, onSend } = mount();
    await waitFor(() => expect(onSend).toHaveBeenCalledExactlyOnceWith('Keep this draft'));
    expect(box).toHaveValue('');
  });
});
