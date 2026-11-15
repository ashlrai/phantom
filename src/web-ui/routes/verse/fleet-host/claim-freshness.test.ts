import { createElement } from 'react';
import { act, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { claimFreshness, sortByFreshness } from './claim-freshness.js';
import { ClaimExecutionBody } from './ClaimExecutionCard.js';
import { parseClaimExecution } from './claim-execution-model.js';

const READ_AT = '2026-11-14T22:31:00Z';
const NOW = Date.parse(READ_AT);
const lease = { expiresInSeconds: 600 };

afterEach(() => { vi.useRealTimers(); });

it('labels a fresh row with the observation time and API source', () => {
  const time = new Date(NOW).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  expect(claimFreshness(lease, READ_AT, NOW)).toEqual({
    stale: false, expired: false, label: `as of ${time} · claim execution API`,
  });
});

it('marks reads older than two minutes stale, including unknown leases', () => {
  expect(claimFreshness(lease, READ_AT, NOW + 120_000).stale).toBe(false);
  expect(claimFreshness(lease, READ_AT, NOW + 120_001).stale).toBe(true);
  expect(claimFreshness({ expiresInSeconds: 'unknown' }, READ_AT, NOW + 120_001))
    .toMatchObject({ stale: true, expired: false });
});

it('expires leases at their deadline and stably sorts them last without mutation', () => {
  const expired = { id: 'expired', expiresInSeconds: 30 };
  const active = { id: 'active', ...lease };
  const unknown = { id: 'unknown', expiresInSeconds: 'unknown' as const };
  const zero = { id: 'zero', expiresInSeconds: 0 };
  const rows = [expired, active, unknown, zero];
  expect(claimFreshness(expired, READ_AT, NOW + 29_999).expired).toBe(false);
  expect(claimFreshness(expired, READ_AT, NOW + 30_000)).toMatchObject({ stale: true, expired: true });
  expect(sortByFreshness(rows, READ_AT, NOW + 30_000)).toEqual([active, unknown, expired, zero]);
  expect(rows).toEqual([expired, active, unknown, zero]);
});

it.each([undefined, null, '', 'unknown', 'invalid'])('treats a missing or invalid readAt (%s) as stale', readAt => {
  expect(claimFreshness(lease, readAt, NOW)).toEqual({ stale: true, expired: false, label: 'as of unknown' });
});

it('keeps a future observation from prematurely aging or expiring a lease', () => {
  expect(claimFreshness(lease, READ_AT, NOW - 30_000)).toMatchObject({ stale: false, expired: false });
});

it('updates row badges and ordering as the displayed snapshot ages without another read', () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const row = (jobId: string, expiresInSeconds: number) => ({
    claimId: jobId, jobId, agent: 'fake-agent', repo: 'fake-repo',
    state: 'CLAIMED_NO_WORKER', worker: null, expiresInSeconds,
  });
  const parsed = parseClaimExecution({ v: 1, authority: 'none', report: {
    schema: 'fleet.claim-execution.v1', authority: 'none', asOf: READ_AT,
    ledger: 'known', processes: 'healthy', rows: [row('fake-short', 30), row('fake-long', 600)],
  } });
  render(createElement(ClaimExecutionBody, { parsed }));
  expect(screen.queryByText('stale')).toBeNull();
  expect(screen.getAllByText(/as of .* · claim execution API/)).toHaveLength(2);
  act(() => { vi.advanceTimersByTime(30_000); });
  const rows = screen.getAllByRole('listitem');
  expect(within(rows[0]).getByText('fake-long')).toBeTruthy();
  expect(within(rows[1]).getByText('fake-short')).toBeTruthy();
  expect(within(rows[1]).getByText('stale')).toBeTruthy();
  act(() => { vi.advanceTimersByTime(95_000); });
  expect(screen.getAllByText('stale')).toHaveLength(2);
});
