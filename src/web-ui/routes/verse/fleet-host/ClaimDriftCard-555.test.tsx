import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { evictAll, getQuerySnapshot, invalidate } from '../../../data/cache.js';
import { ClaimDriftCard } from './ClaimDriftCard.js';
import { claimDriftHeadline, parseClaimDrift } from './claim-drift-model.js';

const ASOF = '2026-11-14T12:00:00.000Z';
const row = (o: Record<string, unknown> = {}) => ({
  id: 'fake-claim', cursor: 1, receivedAt: ASOF, owner: 'fake-owner', leaseUntil: '2026-11-14T13:00:00.000Z', ...o,
});
const body = (o: Record<string, unknown> = {}) => ({
  v: 1, authority: 'none', generatedAt: ASOF,
  drift: {
    schema: 'fleet.claim-drift.v1', asOf: ASOF, bus: 'available', coordination: 'available', matched: 3,
    busOnly: [], coordOnly: [], ownerMismatch: [], state: 'VERIFIED', missing: [], ...o,
  },
});
const serve = (b: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(b), { status: 200 })));

beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('renders VERIFIED', async () => {
  serve(body());
  render(<ClaimDriftCard visible />);
  expect(await screen.findByText(/Claim stores agree \(3 live claims\).*as of 2026-11-14T12:00:00.000Z/)).toBeTruthy();
});

it('renders DRIFT with owner-mismatch as bus→coord in the danger tone', async () => {
  serve(body({
    state: 'DRIFT',
    busOnly: [row({ id: 'bus-1' })],
    coordOnly: [row({ id: 'coord-1' })],
    ownerMismatch: [row({ id: 'mm-1', busOwner: 'owner-bus', coordOwner: 'owner-coord' })],
  }));
  render(<ClaimDriftCard visible />);
  const head = await screen.findByText(/Claim stores disagree: 1 bus-only, 1 coord-only, 1 owner mismatch/);
  expect(head.getAttribute('data-tone')).toBe('bad');
  expect(screen.getByText('owner-bus→owner-coord')).toBeTruthy();
  expect(screen.getByText('bus-1')).toBeTruthy();
  expect(screen.getByText('coord-1')).toBeTruthy();
});

it('caps rows at 8', async () => {
  serve(body({ state: 'DRIFT', busOnly: Array.from({ length: 10 }, (_, i) => row({ id: `b-${i}` })) }));
  render(<ClaimDriftCard visible />);
  expect(await screen.findByText('+2 more')).toBeTruthy();
  expect(screen.queryByText('b-8')).toBeNull();
});

it('renders UNKNOWN as not fine', async () => {
  serve(body({ state: 'UNKNOWN', bus: 'unavailable', missing: ['bus'] }));
  render(<ClaimDriftCard visible />);
  const head = await screen.findByText(/Claim stores unknown: bus unreadable/);
  expect(head.getAttribute('data-tone')).toBe('warn');
});

it('renders the request failure text', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  render(<ClaimDriftCard visible />);
  expect(await screen.findByText('Claim stores unknown: request failed')).toBeTruthy();
});

it('marks a cached claim report stale after a 503 refresh', async () => {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(Response.json(body()))
    .mockResolvedValueOnce(new Response('{}', { status: 503 })));
  render(<ClaimDriftCard visible />);
  expect(await screen.findByText(/Claim stores agree/)).toBeTruthy();
  const lastSuccess = getQuerySnapshot('verse-fleet-claim-drift').updatedAt;
  expect(lastSuccess).not.toBeNull();

  invalidate('verse-fleet-claim-drift');

  const warning = await screen.findByRole('status');
  expect(warning.textContent).toContain('Refresh failed; showing the last claim-store report, which may be stale.');
  expect(warning.querySelector('time')?.getAttribute('datetime')).toBe(new Date(lastSuccess!).toISOString());
  expect(screen.getByText(/Stale evidence: Claim stores agree/)).toBeTruthy();
  expect(getQuerySnapshot('verse-fleet-claim-drift').updatedAt).toBe(lastSuccess);
});

it('parser rejects bad shapes and headline names missing sources', () => {
  expect(parseClaimDrift(null)).toBeNull();
  expect(parseClaimDrift({ drift: { state: 'NOPE' } })).toBeNull();
  expect(parseClaimDrift(body({ busOnly: 'x' }))).toBeNull();
  const v = parseClaimDrift(body({ state: 'UNKNOWN', missing: ['bus', 'coordination'] }))!;
  expect(claimDriftHeadline(v).text).toContain('bus, coordination unreadable');
});
