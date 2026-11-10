import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { ApiError, apiGet, apiPost } from '../../../data/client.js';
import { NeedsMasonRows } from './FleetNeedsYouRows.js';
import { AUTO_RESOLVE_REPLY } from './needs-mason-triage-model.js';

vi.mock('../../../data/client.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../data/client.js')>(),
  apiGet: vi.fn(), apiPost: vi.fn(),
}));

const RESOLVE = '/api/verse/agent-bus/needs-mason/resolve';
const items = [
  { id: 'fake-hard', text: 'Approve the fake $40 plan change' },
  { id: 'fake-a', text: 'unpark RQ-FAKE-1' },
  { id: 'fake-b', text: 'unpark RQ-FAKE-2' },
];

beforeEach(() => {
  evictAll();
  setMutationToken('fake-token');
  vi.mocked(apiGet).mockImplementation(async path => {
    if (path === '/api/verse/agent-bus/needs-mason') return { items } as never;
    throw new Error('unavailable');
  });
});
afterEach(() => {
  clearMutationToken();
  vi.clearAllMocks();
});

it('batch-resolves only the lines outside the hard limits', async () => {
  vi.mocked(apiPost).mockResolvedValueOnce({}).mockRejectedValueOnce(new ApiError('conflict', 409, RESOLVE));
  render(<NeedsMasonRows />);
  expect(await screen.findByText('Hard limit: money or billing')).toBeTruthy();
  expect(screen.getByText('Outside the hard limits (2)')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Resolve all 2' }));
  expect(await screen.findByText('Resolved 1, 1 already resolved, 0 failed')).toBeTruthy();
  await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2));
  expect(vi.mocked(apiPost).mock.calls.map(call => call.slice(0, 2))).toEqual([
    [RESOLVE, { itemId: 'fake-a', reply: AUTO_RESOLVE_REPLY }],
    [RESOLVE, { itemId: 'fake-b', reply: AUTO_RESOLVE_REPLY }],
  ]);
  expect(screen.getByText(items[0].text)).toBeTruthy();
  expect(screen.queryByText('unpark RQ-FAKE-1')).toBeNull();
  expect(screen.queryByText('unpark RQ-FAKE-2')).toBeNull();
});
