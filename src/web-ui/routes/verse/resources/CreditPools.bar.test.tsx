import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { CreditPools } from './CreditPools.js';
import { CREDIT_POOLS_PATH, type CreditPoolsRead } from '../../../../core/verse/credit-pools-api-types.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';

const at = '2026-10-01T12:00:00.000Z';
const manual = { kind: 'verified-manual', adapter: 'claude-account-ui' } as const;
function fixture(): CreditPoolsRead {
  return { v: 2, state: 'current', refreshedAt: at, pools: { v: 1, sourceState: 'healthy', rows: [
    { poolId: 'gift', accountId: 'sample-claude', provider: 'claude', kind: 'gifted-cloud', amount: '12.5', total: '50', unit: 'USD',
      surface: 'cloud-session', capturedAt: at, expiresAt: '2026-11-01T12:00:00.000Z', expiryKind: 'fixed',
      source: manual, identityState: 'matched', evidenceState: 'recorded', expiryState: 'upcoming' },
    { poolId: 'paid', accountId: 'sample-claude', provider: 'claude', kind: 'purchased-usage', amount: '9.75', total: null, unit: 'USD',
      surface: 'over-plan-usage', capturedAt: at, expiresAt: null, expiryKind: 'unknown',
      source: manual, identityState: 'matched', evidenceState: 'recorded', expiryState: 'unknown' },
    { poolId: 'old-gift', accountId: 'other-claude', provider: 'claude', kind: 'gifted-cloud', amount: null, total: null, unit: 'USD',
      surface: 'cloud-session', capturedAt: at, expiresAt: '2026-10-02T00:00:00.000Z', expiryKind: 'fixed',
      source: manual, identityState: 'unknown', evidenceState: 'identity-unknown', expiryState: 'expired' },
  ] }, apiGrants: { v: 1, state: 'healthy', rows: [{
    v: 1, state: 'recorded', remainingUsdMicros: '150000000', totalUsdMicros: '200000000', capturedAt: at,
    expiryDate: '2026-10-24', admissionCutoff: '2026-10-24T00:00:00.000Z', cutoffPolicy: 'expiry-day-start/v1', automaticAdmission: 'held',
  }] } };
}
async function open(value: CreditPoolsRead) {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-02T12:00:00.000Z'));
  stubSurfaceFetch({ routes: { [CREDIT_POOLS_PATH]: value } });
  render(<CreditPools accountNames={new Map([['sample-claude', 'My Claude']])} />);
  fireEvent.click(screen.getByText('Credit balances'));
  await act(async () => { await vi.advanceTimersByTimeAsync(5); });
}
const card = (kind: string, index = 0) => document.querySelectorAll<HTMLElement>(`li[data-credit="${kind}"]`)[index]!;

beforeEach(() => evictAll());
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Credit balance cards', () => {
  it('draws the share of a recorded grant gone at capture as a named meter, with the provider mark and the deadline countdown', async () => {
    await open(fixture());
    const gift = card('gifted-cloud');
    const meter = within(gift).getByRole('meter', { name: 'Cloud gift, My Claude: share spent' });
    expect(meter).toHaveAttribute('aria-valuenow', '75');
    expect(meter).toHaveAttribute('aria-valuetext', '75% of the recorded grant was gone at capture.');
    expect(meter.querySelector('i[data-part="used"]')).toHaveStyle({ width: '75%' });
    expect(gift.querySelector('p[data-spent="share"]')).toHaveTextContent('75% of the recorded grant was gone at capture.');
    expect(gift.querySelector('svg')).not.toBeNull();
    expect(gift.querySelector('p[data-deadline="ahead"] [data-countdown]')).toHaveTextContent('in 30d 0h');
    expect(gift.querySelector('[data-capture-age]')).toHaveTextContent('1d 0h ago');
    expect(gift).not.toHaveAttribute('data-passed');
  });
  it('draws no bar for a balance with no recorded total and says the share is unknown', async () => {
    await open(fixture());
    const paid = card('purchased-usage');
    expect(within(paid).queryByRole('meter')).toBeNull();
    expect(paid.querySelector('p[data-spent="unknown"]')).toHaveTextContent('No total is recorded, so the share spent is unknown.');
    expect(paid.querySelector('p[data-deadline="unknown"]')).toHaveTextContent('Expiry unknown');
    expect(paid.querySelector('[data-countdown]')).toBeNull();
  });
  it('keeps a hidden balance as a hatched meter with no value, marked once its recorded deadline has passed', async () => {
    await open(fixture());
    const hidden = card('gifted-cloud', 1);
    const meter = within(hidden).getByRole('meter', { name: 'Cloud gift, other-claude: share spent' });
    expect(meter).toHaveAttribute('data-unread', 'true');
    expect(meter).not.toHaveAttribute('aria-valuenow');
    expect(meter).toHaveAttribute('aria-valuetext', 'Balance hidden · account not verified');
    expect(hidden).toHaveAttribute('data-passed', 'true');
    expect(hidden.querySelector('p[data-deadline="passed"]')).toHaveTextContent('Recorded deadline has passed');
    expect(hidden.querySelector('[data-countdown]')).toBeNull();
    expect(hidden).not.toHaveTextContent('$0');
  });
  it('draws an API promotion the same way and counts down to when Phantom stops new API work', async () => {
    await open(fixture());
    const api = card('api-promotion');
    expect(within(api).getByRole('meter', { name: 'Claude API promotion: share spent' })).toHaveAttribute('aria-valuenow', '25');
    expect(api.querySelector('[data-countdown]')).toHaveTextContent(', in 21d 12h');
    expect(api).toHaveTextContent(/Phantom stops new API work at the start of the expiry date \(UTC\), in 21d 12h\./);
    expect(api).toHaveTextContent(/Automatic use held/);
  });
  it('says the API cutoff has passed instead of counting down to it', async () => {
    const value = fixture(); if (value.v !== 2) throw new Error('fixture');
    value.apiGrants.rows[0] = { ...value.apiGrants.rows[0]!, expiryDate: '2026-10-01', admissionCutoff: '2026-10-01T00:00:00.000Z' };
    await open(value);
    const api = card('api-promotion');
    expect(api).toHaveTextContent(/Phantom stopped new API work/);
    expect(api.querySelector('[data-countdown]')).toBeNull();
    expect(api).toHaveAttribute('data-passed', 'true');
  });
  it('heads the list with how many balances carry a figure and the first credit deadline, and keys the bar', async () => {
    await open(fixture());
    expect(document.querySelector('p[data-headline]')).toHaveTextContent(
      '3 of 4 balances recorded, 1 without a figure. First deadline: Claude API promotion, in 21d 12h.');
    expect(document.querySelector('p[data-credit-key]')).toHaveTextContent('share gone when the balance was captured');
    expect(screen.getByRole('list', { name: 'Recorded credit balances' }).children).toHaveLength(3);
    expect(screen.getByRole('list', { name: 'Recorded API promotions' }).children).toHaveLength(1);
  });
  it('shows no headline, key or meter when no balance is recorded', async () => {
    const value = fixture(); if (value.v !== 2) throw new Error('fixture');
    value.pools = { v: 1, sourceState: 'missing', rows: [] }; value.apiGrants = { v: 1, state: 'missing', rows: [] };
    await open(value);
    expect(screen.getByText(/No verified credit balance records yet/)).toBeVisible();
    expect(document.querySelector('p[data-headline]')).toBeNull();
    expect(document.querySelector('p[data-credit-key]')).toBeNull();
    expect(screen.queryByRole('meter')).toBeNull();
  });
});
