import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { evictAll, invalidate } from '../../../data/cache.js';
import { ClaimDriftCard } from './ClaimDriftCard.js';

const asOf = '2026-11-14T12:00:00.000Z';
const report = (id: string) => ({ drift: {
  state: 'DRIFT', asOf, matched: 0, missing: [], coordOnly: [], ownerMismatch: [],
  busOnly: [{ id, owner: 'fake-owner', leaseUntil: asOf }],
} });
const trace = (id: string) => ({ v: 1, authority: 'none', generatedAt: asOf, items: [{
  id, state: 'VERIFIED', asOf, source: 'fake', missing: [], owner: 'fake-owner',
  claimReceipt: 'fake-receipt', inbox: 'fake', claims: 'fake',
}] });

beforeEach(() => evictAll());
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('replaces the trace batch when the visible drift IDs change', async () => {
  let current = 'old-id';
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    if (!url.includes('work-trace')) return Response.json(report(current));
    calls.push(url);
    return Response.json(current === 'old-id' ? trace('old-id') : { v: 1, authority: 'none', generatedAt: asOf, items: [] });
  }));
  render(<ClaimDriftCard visible />);
  await waitFor(() => expect(within(screen.getByText('old-id').closest('li')!).getByText('VERIFIED')).toBeTruthy());
  current = 'new-id';
  invalidate('verse-fleet-claim-drift');
  await waitFor(() => expect(within(screen.getByText('new-id').closest('li')!).getByText('state unknown')).toBeTruthy());
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(new URL(calls[1]!, 'http://fake').searchParams.getAll('id')).toEqual(['new-id']);
  expect(screen.queryByText('old-id')).toBeNull();
  expect(screen.queryByText('VERIFIED')).toBeNull();
});
