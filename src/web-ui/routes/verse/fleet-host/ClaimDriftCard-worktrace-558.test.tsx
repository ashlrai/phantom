import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { evictAll, getQuerySnapshot, invalidate } from '../../../data/cache.js';
import { ClaimDriftCard } from './ClaimDriftCard.js';

const ASOF = '2026-11-14T12:00:00.000Z';
const row = (o: Record<string, unknown> = {}) => ({
  id: 'fake-claim', cursor: 1, receivedAt: ASOF, owner: 'worker-a', leaseUntil: '2026-11-14T13:00:00.000Z', ...o,
});
const drift = (o: Record<string, unknown> = {}) => ({
  v: 1, authority: 'none', generatedAt: ASOF,
  drift: {
    schema: 'fleet.claim-drift.v1', asOf: ASOF, bus: 'available', coordination: 'available', matched: 0,
    busOnly: [], coordOnly: [], ownerMismatch: [], state: 'DRIFT', missing: [], ...o,
  },
});
const item = (id: string, state: string, o: Record<string, unknown> = {}) => ({
  id, state, asOf: ASOF, source: 'fake', missing: [], owner: 'worker-a', claimReceipt: `rcpt-${id}`, inbox: 'x', claims: 'y', ...o,
});
const trace = (items: unknown[]) => ({ v: 1, authority: 'none', generatedAt: ASOF, items });

type Handler = (url: string) => Response | Promise<Response>;
function serve(driftBody: unknown, onTrace: Handler) {
  const f = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('work-trace')) return onTrace(url);
    return new Response(JSON.stringify(driftBody), { status: 200 });
  });
  vi.stubGlobal('fetch', f);
  return f;
}
const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
const traceCalls = (f: ReturnType<typeof vi.fn>) => f.mock.calls.map(c => String(c[0])).filter(u => u.includes('work-trace'));
const rowOf = (id: string) => screen.getByText(id).closest('li') as HTMLElement;

beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const threeRows = () => drift({
  busOnly: [row({ id: 'bus-1' })], coordOnly: [row({ id: 'coord-1' })],
  ownerMismatch: [row({ id: 'mm-1', busOwner: 'worker-a', coordOwner: 'worker-b' })],
});

it('shows each trace state on its own row', async () => {
  serve(threeRows(), () => ok(trace([item('bus-1', 'RUNNING'), item('coord-1', 'VERIFIED'), item('mm-1', 'BLOCKED')])));
  render(<ClaimDriftCard visible />);
  await waitFor(() => expect(within(rowOf('bus-1')).getByText('RUNNING')).toBeTruthy());
  expect(within(rowOf('coord-1')).getByText('VERIFIED')).toBeTruthy();
  expect(within(rowOf('mm-1')).getByText('BLOCKED')).toBeTruthy();
  expect(rowOf('bus-1').querySelector('[data-work-state]')?.getAttribute('data-work-state')).toBe('RUNNING');
});

it('notes the bus trace owner on owner-mismatch rows only', async () => {
  serve(threeRows(), () => ok(trace([item('bus-1', 'RUNNING'), item('coord-1', 'VERIFIED'), item('mm-1', 'RUNNING', { owner: 'worker-b' })])));
  render(<ClaimDriftCard visible />);
  await waitFor(() => expect(within(rowOf('mm-1')).getByText('bus trace owner worker-b')).toBeTruthy());
  expect(within(rowOf('bus-1')).queryByText(/bus trace owner/)).toBeNull();
});

it('shows ASSIGNED without a claim receipt as state unknown', async () => {
  serve(drift({ busOnly: [row({ id: 'bus-1' })] }), () => ok(trace([item('bus-1', 'ASSIGNED', { claimReceipt: null })])));
  render(<ClaimDriftCard visible />);
  await waitFor(() => expect(within(rowOf('bus-1')).getByText('state unknown')).toBeTruthy());
  expect(within(rowOf('bus-1')).queryByText('ASSIGNED')).toBeNull();
});

it('a failing trace request reads state unknown on every row while drift rows render', async () => {
  serve(threeRows(), () => { throw new Error('offline'); });
  render(<ClaimDriftCard visible />);
  await waitFor(() => expect(screen.getAllByText('state unknown')).toHaveLength(3));
  for (const id of ['bus-1', 'coord-1', 'mm-1']) expect(within(rowOf(id)).getByText('state unknown')).toBeTruthy();
});

it('an empty drift makes no work-trace request', async () => {
  const f = serve(drift({ state: 'VERIFIED' }), () => ok(trace([])));
  render(<ClaimDriftCard visible />);
  await screen.findByText(/Claim stores agree/);
  expect(traceCalls(f)).toHaveLength(0);
});

it('requests exactly the on-screen ids, deduped, capped at 8', async () => {
  const many = Array.from({ length: 10 }, (_, i) => row({ id: `b-${i}` }));
  const f = serve(drift({ busOnly: many, coordOnly: [row({ id: 'b-0' })] }), () => ok(trace([])));
  render(<ClaimDriftCard visible />);
  await waitFor(() => expect(traceCalls(f).length).toBeGreaterThan(0));
  const url = new URL(traceCalls(f)[0]!, 'http://x');
  expect(url.searchParams.getAll('id')).toEqual(Array.from({ length: 8 }, (_, i) => `b-${i}`));
});

it('marks cached VERIFIED trace evidence stale after a 503 refresh', async () => {
  let reads = 0;
  const f = serve(drift({ busOnly: [row({ id: 'bus-1' })] }), () =>
    ++reads === 1 ? ok(trace([item('bus-1', 'VERIFIED')])) : new Response('{}', { status: 503 }));
  render(<ClaimDriftCard visible />);
  await waitFor(() => expect(within(rowOf('bus-1')).getByText('VERIFIED')).toBeTruthy());
  const key = 'verse-fleet-claim-drift-trace:bus-1';
  const lastSuccess = getQuerySnapshot(key).updatedAt;
  expect(lastSuccess).not.toBeNull();

  invalidate(key);

  const warning = await screen.findByRole('status');
  expect(warning.textContent).toContain('Work-trace refresh failed; showing cached evidence, which may be stale.');
  expect(warning.querySelector('time')?.getAttribute('datetime')).toBe(new Date(lastSuccess!).toISOString());
  expect(within(rowOf('bus-1')).getByText('VERIFIED · stale')).toBeTruthy();
  expect(rowOf('bus-1').querySelector('[data-work-stale="true"]')).not.toBeNull();
  expect(traceCalls(f)).toHaveLength(2);
  expect(getQuerySnapshot(key).updatedAt).toBe(lastSuccess);
});
