import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setMutationToken, clearMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { apiGet, apiPost } from '../../../data/client.js';
import { openInterjectDialog } from '../fleet/interject-dialog-store.js';
import { FLEET_NEEDS_YOU_POLL_MS } from './fleet-needs-you.js';
import { FleetNeedsYouRows } from './FleetNeedsYouRows.js';

vi.mock('../../../data/client.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../data/client.js')>(),
  apiGet: vi.fn(), apiPost: vi.fn(),
}));
vi.mock('../fleet/interject-dialog-store.js', () => ({ openInterjectDialog: vi.fn() }));

const first = { id: 'fake-1', text: 'Pick a fake color' };
let items = [first];
beforeEach(() => {
  evictAll();
  items = [first];
  setMutationToken('fake-token');
  vi.mocked(apiGet).mockImplementation(async path => {
    if (path === '/api/verse/agent-bus/needs-mason') return { items } as never;
    throw new Error('unavailable');
  });
});
afterEach(() => {
  clearMutationToken();
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function resolveWith(inbox: string) {
  vi.mocked(apiPost).mockResolvedValue({ inbox });
  render(<FleetNeedsYouRows split="fleet" nowMs={0} onResult={() => {}} />);
  fireEvent.change(await screen.findByLabelText('Reply for Pick a fake color'), { target: { value: 'Fake blue' } });
  fireEvent.click(screen.getByRole('button', { name: 'Resolve Pick a fake color' }));
}

it('shows delivery after removing the resolved row', async () => {
  await resolveWith('appended');
  expect(await screen.findByText('Resolved. Your reply went to the planner inbox.')).toBeTruthy();
  expect(screen.queryByText(first.text)).toBeNull();
});

it('offers to resend a reply that failed to reach the inbox', async () => {
  await resolveWith('failed');
  expect(await screen.findByText(/Resolved, but your reply did not reach the planner inbox/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Tell the leaders' }));
  expect(openInterjectDialog).toHaveBeenCalledWith({ prefill: 'Re needs-you fake-1: Fake blue' });
});

it('shows new items on a later poll without remounting', async () => {
  vi.useFakeTimers();
  render(<FleetNeedsYouRows split="fleet" nowMs={0} onResult={() => {}} />);
  await act(async () => {});
  expect(screen.getByText(first.text)).toBeTruthy();
  items = [first, { id: 'fake-2', text: 'Pick a fake shape' }];
  await act(async () => { await vi.advanceTimersByTimeAsync(FLEET_NEEDS_YOU_POLL_MS); });
  expect(screen.getByText('Pick a fake shape')).toBeTruthy();
});
