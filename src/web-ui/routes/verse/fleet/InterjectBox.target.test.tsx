import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { InterjectBox } from './InterjectBox.js';

beforeEach(() => { sessionStorage.clear(); localStorage.clear(); evictAll(); setMutationToken('a'.repeat(64)); });
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); });
it('selects a running job and sends its marker; Escape closes suggestions', async () => {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({ at: '2026-10-31T12:00:00Z' }, { status: 201 })
    : Response.json({ v: 1, inbox: [], workers: [{ job: 'RQ-PHX-EXAMPLE', lane: 'codex' }], leaders: [], mergesLastHour: { count: 0 }, switches: [] }));
  vi.stubGlobal('fetch', fetcher);
  const user = userEvent.setup();
  render(<InterjectBox />);
  const box = screen.getByRole('textbox');
  await user.type(box, '@RQ-PH');
  expect(await screen.findByRole('option', { name: 'RQ-PHX-EXAMPLE · codex' })).toBeInTheDocument();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  await user.type(box, 'X');
  await screen.findByRole('listbox');
  await user.keyboard('{Enter}');
  expect(box).toHaveValue('@RQ-PHX-EXAMPLE ');
  expect(screen.getByText('Aimed at RQ-PHX-EXAMPLE')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST' && JSON.parse(String(init.body)).text === '@RQ-PHX-EXAMPLE')).toBe(true));
});
