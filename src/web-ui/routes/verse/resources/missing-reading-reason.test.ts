import { describe, expect, it } from 'vitest';
import type { CapacityRow } from '../usage/capacity-strip-model.js';
import { missingReadingReason } from './missing-reading-reason.js';

const NOW = Date.parse('2026-01-01T12:00:30.000Z');
function row(over: Partial<CapacityRow> = {}): CapacityRow {
  return {
    seatId: 'synthetic', label: 'Synthetic', engine: 'codex', monogram: 'C', kind: 'subscription', plan: null,
    cls: 'unknown' as CapacityRow['cls'], word: 'no reading', summary: '', connection: null, windows: [], credits: null,
    reserve: null, notes: [], localCount: 1, checkedAt: '2026-01-01T12:00:00.000Z', resetAt: null, signedOut: false, ...over,
  };
}
const connection = (c: 'connected' | 'expiring', reasons: string[]): CapacityRow['connection'] =>
  ({ connection: c, word: c, tone: 'neutral', reasons, fixKind: 'none', fixCommand: null }) as CapacityRow['connection'];

describe('missingReadingReason', () => {
  it('names a never-checked row', () => {
    expect(missingReadingReason(row({ checkedAt: null }), NOW)).toEqual({ cause: 'No usage check has run on this computer yet.', fix: 'Check now' });
  });
  it('treats an unparseable or future check time as never checked', () => {
    expect(missingReadingReason(row({ checkedAt: 'nope' }), NOW).cause).toContain('No usage check has run');
    expect(missingReadingReason(row({ checkedAt: '2026-01-02T00:00:00.000Z' }), NOW).cause).toContain('No usage check has run');
  });
  it('names a signed-out account', () => {
    expect(missingReadingReason(row({ signedOut: true }), NOW)).toEqual({ cause: 'This account is signed out.', fix: 'Reconnect this account' });
  });
  it('names a recorded probe timeout', () => {
    expect(missingReadingReason(row({ engine: 'claude', quotaReadReason: 'status-usage-timed-out' }), NOW)).toEqual({ cause: 'The usage check timed out.', fix: 'Check now' });
  });
  it('names an unavailable reader', () => {
    expect(missingReadingReason(row({ engine: 'claude', quotaReadReason: 'usage-version-unsupported' }), NOW).cause).toContain('not available in this build');
  });
  it('names a provider that did not report windows', () => {
    expect(missingReadingReason(row({ engine: 'claude', quotaReadReason: 'usage-output-invalid' }), NOW).cause).toContain('did not report usage windows');
  });
  it('uses a recorded connection failure reason', () => {
    expect(missingReadingReason(row({ connection: connection('expiring', ['Access expires soon']) }), NOW)).toEqual({ cause: 'Access expires soon.', fix: 'Check now' });
  });
  it.each(['local', 'devin'] as const)('says %s has no plan usage to read', engine => {
    expect(missingReadingReason(row({ engine }), NOW)).toEqual({ cause: 'This provider does not report plan usage to Phantom.', fix: 'None needed' });
  });
  it('explains unknown Codex credits', () => {
    expect(missingReadingReason(row({ creditState: 'unknown' }), NOW).cause).toBe('Credits are only read when the account is signed in on this computer.');
  });
  it('falls back for an unknown case', () => {
    expect(missingReadingReason(row({ engine: 'grok' }), NOW)).toEqual({ cause: 'The provider did not report a usable reading.', fix: 'Check now' });
  });
});
