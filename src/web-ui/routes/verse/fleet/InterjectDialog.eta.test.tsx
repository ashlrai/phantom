import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evict } from '../../../data/cache.js';
import { InterjectDialog } from './InterjectDialog.js';
import { closeInterjectDialog, openInterjectDialog } from './interject-dialog-store.js';
import { inboxTailQuery } from './interject-queries.js';

afterEach(() => {
  act(closeInterjectDialog);
  clearMutationToken();
  evict(inboxTailQuery.key);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('shows the leader clock before and after sending and closes after two seconds', async () => {
  const now = Date.now();
  const fetcher = vi.fn((path: string) => Promise.resolve(Response.json(path.endsWith('/inbox')
    ? { ok: true, at: new Date(now).toISOString() }
    : { generatedAt: new Date(now).toISOString(), leaders: [{ label: 'claude', ageSeconds: 300 }], inbox: [] })));
  vi.stubGlobal('fetch', fetcher);
  setMutationToken('a'.repeat(64));
  render(<InterjectDialog />);
  act(openInterjectDialog);
  await waitFor(() => expect(screen.getByRole('dialog')).toHaveAccessibleDescription(/Next leader pass in ~10 min, last pass 5 min ago/));
  expect(fetcher).toHaveBeenCalledWith('/api/verse/fleet/runs', expect.anything());

  vi.useFakeTimers();
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Please check the queue' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Send/ })); });
  expect(screen.getByRole('status')).toHaveTextContent(/^Landed at \d{2}:\d{2} · expected to be read next pass in ~10 min$/);
  act(() => vi.advanceTimersByTime(1_999));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
