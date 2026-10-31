import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { InboxPostBox } from './InboxPostBox.js';

beforeEach(() => { sessionStorage.clear(); setMutationToken('a'.repeat(64)); });
afterEach(() => { cleanup(); clearMutationToken(); vi.unstubAllGlobals(); });
function compose(onPosted = vi.fn()) {
  render(<InboxPostBox onPosted={onPosted} />);
  const box = screen.getByRole('textbox');
  fireEvent.change(box, { target: { value: 'Hello' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  return { box, onPosted };
}
it('reports a duplicate, clears the draft and does not highlight', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ at: 'now', duplicate: true, accepted: false })));
  const { box, onPosted } = compose();
  await screen.findByText('Already in the inbox · sent within the last 10 minutes');
  expect(box).toHaveValue('');
  expect(onPosted).not.toHaveBeenCalled();
});
it('shows the local time after a write', async () => {
  const at = new Date(2026, 9, 31, 5, 42).toISOString();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ at, duplicate: false, accepted: true })));
  const { onPosted } = compose();
  await screen.findByText('Sent · 05:42');
  expect(onPosted).toHaveBeenCalledWith('Hello');
});
it('keeps the draft on 503 and retries the same text', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ error: 'Unavailable' }, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ at: new Date(2026, 9, 31, 5, 42).toISOString(), accepted: true }));
  vi.stubGlobal('fetch', fetcher);
  const { box, onPosted } = compose();
  await screen.findByText('Unavailable');
  expect(box).toHaveValue('Hello');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByText('Sent · 05:42');
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body)).text).toBe('Hello');
  expect(box).toHaveValue('');
  expect(onPosted).toHaveBeenCalledTimes(1);
});
