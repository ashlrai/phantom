import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { InterjectBox } from './InterjectBox.js';
import { LAST_SENT_KEY } from './interject-correction.js';

const ORIGINAL = 'desk-0123456789abcdef';

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); evictAll(); setMutationToken('a'.repeat(64)); });
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function stubInbox() {
  let next = 0;
  const ids = [ORIGINAL, 'desk-fedcba9876543210'];
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({ ok: true, at: '2026-11-04T23:07:00Z', id: ids[next++] }, { status: 201 })
    : Response.json({ inbox: [] }));
  vi.stubGlobal('fetch', fetcher);
  const posted = () => fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')
    .map(([, init]) => JSON.parse(String(init?.body)) as { text: string });
  return { posted };
}

async function sendFirst(text: string) {
  const box = screen.getByRole('textbox');
  fireEvent.change(box, { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByRole('button', { name: 'Correct last message' });
  return box;
}

it('sends an edited correction tied to the original entry id', async () => {
  const { posted } = stubInbox();
  render(<InterjectBox />);
  expect(screen.queryByRole('button', { name: 'Correct last message' })).toBeNull();
  const box = await sendFirst('Tell dad the build is green');
  fireEvent.click(screen.getByRole('button', { name: 'Correct last message' }));
  expect(box).toHaveValue('Tell dad the build is green');
  expect(screen.getByText(/^Correcting your \d\d:\d\d message/)).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'Run as task' })).toBeDisabled();
  fireEvent.change(box, { target: { value: 'Tell Dot the build is green' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await vi.waitFor(() => expect(posted()).toHaveLength(2));
  expect(posted()[0]!.text).toBe('Tell dad the build is green');
  expect(posted()[1]!.text).toBe(`CORRECTION to ${ORIGINAL}: Tell Dot the build is green`);
  await vi.waitFor(() => expect(screen.queryByText(/^Correcting your/)).toBeNull());
  // The correction is itself correctable and points at its own entry.
  expect(JSON.parse(localStorage.getItem(LAST_SENT_KEY)!)).toMatchObject({ id: 'desk-fedcba9876543210', text: 'Tell Dot the build is green' });
});

it('Cancel correction and Escape restore the earlier draft', async () => {
  const { posted } = stubInbox();
  render(<InterjectBox />);
  const box = await sendFirst('Original');
  fireEvent.change(box, { target: { value: 'Half-typed next thought' } });
  fireEvent.click(screen.getByRole('button', { name: 'Correct last message' }));
  expect(box).toHaveValue('Original');
  fireEvent.click(screen.getByRole('link', { name: 'Cancel correction' }));
  expect(box).toHaveValue('Half-typed next thought');
  expect(screen.queryByText(/^Correcting your/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Correct last message' }));
  fireEvent.keyDown(box, { key: 'Escape' });
  expect(box).toHaveValue('Half-typed next thought');
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await vi.waitFor(() => expect(posted()).toHaveLength(2));
  expect(posted()[1]!.text).toBe('Half-typed next thought');
});

it('hides the button once the 30 minute window has passed', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  stubInbox();
  render(<InterjectBox />);
  await sendFirst('Original');
  await act(async () => { vi.advanceTimersByTime(31 * 60_000); });
  expect(screen.queryByRole('button', { name: 'Correct last message' })).toBeNull();
});

it('does not offer a correction for a send whose id the server did not return', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({ at: '2026-11-04T23:07:00Z' }, { status: 201 }) : Response.json({ inbox: [] })));
  localStorage.setItem(LAST_SENT_KEY, JSON.stringify({ id: ORIGINAL, text: 'Older', sentAtMs: Date.now() }));
  render(<InterjectBox />);
  expect(screen.getByRole('button', { name: 'Correct last message' })).toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Newer' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText(/^Sent ·/);
  expect(screen.queryByRole('button', { name: 'Correct last message' })).toBeNull();
  expect(localStorage.getItem(LAST_SENT_KEY)).toBeNull();
});
