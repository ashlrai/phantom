import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { WorkerLogPane } from './WorkerLogPane.js';

const job = 'RQ-PHX-EXAMPLE1';
const textUrl = `/api/fleet/job/text?id=${job}&kind=notes`;
beforeEach(() => { evictAll(); vi.useFakeTimers(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); evictAll(); });
async function show(status = 200, state = 'ok') {
  const fetch = vi.fn(async (input: string) => {
    const isText = input.includes('/job/text');
    const body = isText ? { v: 1, job, kind: 'notes', state, bytes: 19, truncated: false, text: 'Implemented the fix.' }
      : input.includes('/job?') ? { schema: 'fleet.job.v1', state: 'published', log: { source: 'missing', tail: [] } } : null;
    return new Response(JSON.stringify(body), { status: isText ? status : input.includes('/job/changes') ? 404 : 200 });
  });
  vi.stubGlobal('fetch', fetch);
  render(<WorkerLogPane visible />);
  await act(async () => { fireEvent.change(screen.getByLabelText('Job ID'), { target: { value: job } }); });
  const notes = screen.getByText('Notes (what the worker reported)').closest('details')!;
  return { fetch, notes };
}
async function open(details: HTMLDetailsElement) {
  await act(async () => { details.open = true; fireEvent(details, new Event('toggle')); });
}
it('fetches Notes once on opening, never polls, and refreshes on demand', async () => {
  const { fetch, notes } = await show();
  expect(fetch.mock.calls.filter(([url]) => url.includes('/job/text'))).toHaveLength(0);
  await open(notes);
  expect(screen.getByText('Implemented the fix.')).toBeInTheDocument();
  expect(fetch.mock.calls.filter(([url]) => url === textUrl)).toHaveLength(1);
  await act(async () => { vi.advanceTimersByTime(30_000); });
  expect(fetch.mock.calls.filter(([url]) => url === textUrl)).toHaveLength(1);
  await act(async () => { fireEvent.click(within(notes).getByRole('button', { name: 'Refresh' })); });
  expect(fetch.mock.calls.filter(([url]) => url === textUrl)).toHaveLength(2);
});
it('explains an older server returning 404', async () => {
  const { notes } = await show(404);
  await open(notes);
  expect(within(notes).getByText('Not in this build yet')).toBeInTheDocument();
});
it.each([['missing', 'No notes yet'], ['unreadable', 'Could not read']])('renders %s', async (state, message) => {
  const { notes } = await show(200, state);
  await open(notes);
  expect(within(notes).getByText(message)).toBeInTheDocument();
});
