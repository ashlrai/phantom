import { describe, expect, it } from 'vitest';
import type { ClaudeApiGrantView } from '../../../../core/resources/claude-api-grant-types.js';
import type { CreditPoolRowView } from '../../../../core/resources/credit-pool-types.js';
import { apiGrantBar, creditPoolBar, creditSummary, spanText, summaryWords } from './credit-bar-model.js';

const at = '2026-10-01T12:00:00.000Z';
const now = Date.parse('2026-10-02T12:00:00.000Z');
function pool(over: Partial<CreditPoolRowView> = {}): CreditPoolRowView {
  return { poolId: 'gift', accountId: 'sample-claude', provider: 'claude', kind: 'gifted-cloud', amount: '12.5', total: '50', unit: 'USD',
    surface: 'cloud-session', capturedAt: at, expiresAt: '2026-11-01T12:00:00.000Z', expiryKind: 'fixed',
    source: { kind: 'verified-manual', adapter: 'claude-account-ui' }, identityState: 'matched', evidenceState: 'recorded', expiryState: 'upcoming', ...over };
}
function grant(over: Partial<ClaudeApiGrantView> = {}): ClaudeApiGrantView {
  return { v: 1, state: 'recorded', remainingUsdMicros: '150000000', totalUsdMicros: '200000000', capturedAt: at,
    expiryDate: '2026-10-24', admissionCutoff: '2026-10-24T00:00:00.000Z', cutoffPolicy: 'expiry-day-start/v1', automaticAdmission: 'held', ...over };
}

describe('creditPoolBar', () => {
  it('draws the share of the recorded grant gone at capture', () => {
    expect(creditPoolBar(pool(), '$13 last recorded')).toEqual({ drawn: true, used: 75, counts: 'share spent',
      words: '75% of the recorded grant was gone at capture.', line: '75% of the recorded grant was gone at capture.' });
    expect(creditPoolBar(pool({ kind: 'purchased-usage', surface: 'over-plan-usage', amount: '15', total: '15' }), '').line)
      .toBe('0% of the recorded total was gone at capture.');
  });
  it('draws no bar when the balance is known and the grant is not, or the grant is zero', () => {
    for (const total of [null, '0']) {
      const bar = creditPoolBar(pool({ total }), '$13 last recorded');
      expect(bar).toMatchObject({ drawn: false, used: null, line: 'No grant is recorded, so the share spent is unknown.' });
    }
  });
  it('keeps an unknown or hidden balance unread, never an empty bar', () => {
    expect(creditPoolBar(pool({ amount: null }), 'Balance unknown')).toEqual({ drawn: true, used: null, counts: 'share spent', words: 'Balance unknown', line: null });
    expect(creditPoolBar(pool({ amount: null, total: null, identityState: 'mismatch', evidenceState: 'identity-mismatch' }), 'Balance hidden · account changed'))
      .toMatchObject({ drawn: true, used: null, words: 'Balance hidden · account changed' });
  });
  it('draws a subscription window as the share recorded used, with the figure as its words', () => {
    const row = pool({ kind: 'subscription-allowance', unit: 'percent', surface: 'subscription', amount: '42.4', total: null,
      source: { kind: 'native-metadata', adapter: 'claude-usage' }, evidenceState: 'current-native' });
    expect(creditPoolBar(row, '42% used')).toEqual({ drawn: true, used: 42.4, counts: 'used', words: '42% used', line: null });
    expect(creditPoolBar({ ...row, amount: null }, 'Usage unknown')).toMatchObject({ drawn: true, used: null });
  });
});

describe('apiGrantBar', () => {
  it('draws the share of the grant gone, and stays unread or undrawn without the figures', () => {
    expect(apiGrantBar(grant())).toMatchObject({ drawn: true, used: 25, line: '25% of the recorded grant was gone at capture.' });
    expect(apiGrantBar(grant({ remainingUsdMicros: null }))).toEqual({ drawn: true, used: null, counts: 'share spent', words: 'API promotional balance unknown', line: null });
    expect(apiGrantBar(grant({ totalUsdMicros: null }))).toMatchObject({ drawn: false, used: null });
  });
});

describe('creditSummary', () => {
  it('counts balances with a figure and names the first credit deadline ahead', () => {
    const summary = creditSummary([pool(), pool({ poolId: 'paid', amount: null })], [grant()], now);
    expect(summary).toEqual({ recorded: 2, listed: 3, next: { title: 'Claude API promotion', at: '2026-10-24T00:00:00.000Z' } });
    expect(summaryWords(summary, now)).toBe('2 of 3 balances recorded, 1 without a figure. First deadline: Claude API promotion, in 21d 12h.');
  });
  it('does not treat a subscription reset or a passed deadline as a credit deadline', () => {
    const subscription = pool({ kind: 'subscription-allowance', unit: 'percent', surface: 'subscription', amount: '10', total: null,
      expiresAt: '2026-10-03T00:00:00.000Z', source: { kind: 'native-metadata', adapter: 'claude-usage' }, evidenceState: 'current-native' });
    const summary = creditSummary([subscription, pool({ expiresAt: '2026-10-02T00:00:00.000Z' })], [], now);
    expect(summary.next).toBeNull();
    expect(summaryWords(summary, now)).toBe('2 balances recorded. No credit deadline ahead is recorded.');
    expect(summaryWords(creditSummary([pool({ expiresAt: null, expiryKind: 'unknown', expiryState: 'unknown' })], [], now), now))
      .toBe('1 balance recorded. No credit deadline ahead is recorded.');
  });
});

describe('spanText', () => {
  it('writes days, hours or minutes, whichever way the gap points', () => {
    expect(spanText(30 * 86_400_000)).toBe('30d 0h');
    expect(spanText(-(5 * 3_600_000 + 12 * 60_000))).toBe('5h 12m');
    expect(spanText(59_000)).toBe('0m');
  });
});
