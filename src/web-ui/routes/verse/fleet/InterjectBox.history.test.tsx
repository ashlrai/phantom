import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { InterjectBox } from './InterjectBox.js';
import { HISTORY_KEY } from './interject-history.js';

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); evictAll(); setMutationToken('a'.repeat(64)); });
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); });

it('recalls confirmed sends and restores the live draft', async () => {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({ at: '2026-10-31T12:00:00Z' }, { status: 201 }) : Response.json({ inbox: [] }));
  vi.stubGlobal('fetch', fetcher);
  render(<InterjectBox />);
  const box = screen.getByRole('textbox');
  fireEvent.change(box, { target: { value: 'Last message' } });
  fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
  await screen.findByText(/^Sent ·/);
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  expect(localStorage.getItem(HISTORY_KEY)).toBe(JSON.stringify(['Last message']));
  fireEvent.keyDown(box, { key: 'ArrowUp' });
  expect(box).toHaveValue('Last message');
  fireEvent.keyDown(box, { key: 'ArrowDown' });
  expect(box).toHaveValue('');
  fireEvent.change(box, { target: { value: 'Live draft' } });
  fireEvent.keyDown(box, { key: 'ArrowUp' });
  expect(box).toHaveValue('Last message');
  fireEvent.keyDown(box, { key: 'ArrowDown' });
  expect(box).toHaveValue('Live draft');
  expect(screen.getByText('⌘↵ or Ctrl↵ send · ↑ history · Esc clear')).toBeInTheDocument();
});

it('leaves up on the second line and down on the first line to normal editing', () => {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(['Previous']));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ inbox: [] })));
  render(<InterjectBox />);
  const box = screen.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: 'first\nsecond' } });
  box.setSelectionRange(8, 8);
  expect(fireEvent.keyDown(box, { key: 'ArrowUp' })).toBe(true);
  box.setSelectionRange(2, 2);
  expect(fireEvent.keyDown(box, { key: 'ArrowDown' })).toBe(true);
  expect(box).toHaveValue('first\nsecond');
});

it('does not save a refused send to history', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({ error: 'Refused' }, { status: 422 }) : Response.json({ inbox: [] })));
  render(<InterjectBox />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep this' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText('Refused');
  expect(localStorage.getItem(HISTORY_KEY)).toBeNull();
  expect(screen.getByRole('textbox')).toHaveValue('Keep this');
});
