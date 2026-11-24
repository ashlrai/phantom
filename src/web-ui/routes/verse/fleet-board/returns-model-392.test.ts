import { expect, it } from 'vitest';
import { parseReturns, returnsHeadline, RETURNS_UNKNOWN_REASON } from './returns-model.js';

const NOW = Date.parse('2026-11-14T18:00:00.000Z');
const ROW = {
  claimId: 'fake-392', repo: 'example/phantom', result: 'VERIFIED', evidenceKind: 'pr',
  pr: 42, head: 'abcdef1234567890', evidence: 'pr #42 head abcdef1234567890', from: 'fake-agent',
  at: '2026-11-14T18:00:00.000Z', expiresAt: '2026-11-15T18:00:00.000Z', temporal: 'current',
};
const BLOCKED = { ...ROW, claimId: 'fake-blocked', result: 'BLOCKED', evidenceKind: 'dependency', pr: null, head: null, evidence: 'dependency fake-api' };
const body = (over: Record<string, unknown> = {}) => ({
  v: 1, authority: 'none', generatedAt: ROW.at, source: 'coordination-ledger', asOf: new Date(NOW).toISOString(),
  state: 'known', returns: [ROW, BLOCKED], unparsed: 0, ...over,
});

it('keeps known PR and dependency evidence with a blocked headline', () => {
  const parsed = parseReturns(body());
  expect(parsed.rows).toEqual([ROW, BLOCKED]);
  expect(returnsHeadline(parsed, NOW)).toEqual({ text: '1 current verified, 1 current blocked · 0 background', tone: 'danger' });
  expect(returnsHeadline(parseReturns(body({ returns: [ROW] })), NOW)).toEqual({ text: '1 current verified, 0 current blocked · 0 background', tone: 'success' });
});

it('uses a fixed unknown reason and suppresses rows', () => {
  const parsed = parseReturns(body({ state: 'unknown', reason: '<untrusted reason>' }));
  expect(parsed.rows).toEqual([]);
  expect(returnsHeadline(parsed, NOW).text).toBe(`Results unknown: ${RETURNS_UNKNOWN_REASON}`);
});

it('drops and counts malformed rows without losing valid receipts', () => {
  const malformed = [null, { ...ROW, pr: '42' }, { ...ROW, head: 'bad' },
    { ...BLOCKED, result: 'VERIFIED' }, { ...ROW, at: 'yesterday' }, { ...ROW, from: {} },
    { ...ROW, evidenceKind: ['pr'] }, { ...ROW, expiresAt: null }];
  const parsed = parseReturns(body({ returns: [ROW, ...malformed], unparsed: 2 }));
  expect(parsed.rows).toEqual([ROW]);
  expect(parsed.dropped).toBe(malformed.length);
  expect(parsed.unparsed).toBe(2);
});

it('rejects malformed envelopes instead of reporting zero results', () => {
  for (const value of [null, {}, body({ v: 2 }), body({ authority: 'agent' }),
    body({ state: [] }), body({ returns: {} }), body({ unparsed: -1 })]) {
    expect(returnsHeadline(parseReturns(value))).toEqual({ text: 'Results unknown: invalid results response', tone: 'neutral' });
  }
});
