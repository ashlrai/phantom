import { expect, it } from 'vitest';
import { parsePeerLedger, peerLedgerHeadline } from './peer-ledger-model.js';

const report = (extra: Record<string, unknown> = {}) => ({
  v: 1, authority: 'none', status: 'ok', asOf: '2026-11-15T00:00:00Z', liveRows: 12, capacity: 1024, windowMs: 3600000,
  pairLimit: 6, maxHops: 8,
  pairs: [{ fromAgent: 'dot', target: 'claude', inWindow: 6, remaining: 0, lastAt: '2026-11-15T00:00:00Z' }],
  origins: [{ origin: 'slack:T1', maxHop: 7, nearCap: true }],
  truncated: { pairs: false, origins: false }, ...extra,
});
const env = (r: unknown, extra: Record<string, unknown> = {}) => ({ v: 1, authority: 'none', generatedAt: 'x', report: r, ...extra });

it('parses a valid report and writes the headline', () => {
  const view = parsePeerLedger(env(report()));
  expect(view?.pairs).toHaveLength(1);
  expect(peerLedgerHeadline(view!)).toBe('Peer bus: 12 of 1024 rows · 1 pair at limit · 1 thread near hop cap');
});
it('rejects non-none authority, bad version and unknown status', () => {
  expect(parsePeerLedger(env(report(), { authority: 'execution' }))).toBeNull();
  expect(parsePeerLedger(env(report(), { v: 2 }))).toBeNull();
  expect(parsePeerLedger(env(report({ status: 'weird' })))).toBeNull();
  expect(parsePeerLedger(env(null))).toBeNull();
  expect(parsePeerLedger('nope')).toBeNull();
});
it('rejects an ok report with unusable counts', () => {
  expect(parsePeerLedger(env(report({ capacity: 'lots' })))).toBeNull();
});
it('drops malformed pair and origin rows', () => {
  const view = parsePeerLedger(env(report({
    pairs: [null, { fromAgent: 'a' }, { fromAgent: 'a', target: 'b', inWindow: 1, remaining: -1, lastAt: 'x' },
      { fromAgent: 'a', target: 'b', inWindow: 1, remaining: 5, lastAt: 'x' }],
    origins: [{ origin: 'o', maxHop: 'x', nearCap: true }, { origin: 'o2', maxHop: 1, nearCap: 'yes' }, 7],
  })));
  expect(view?.pairs).toHaveLength(1);
  expect(view?.origins).toHaveLength(0);
});
it('strips control characters and caps strings at 64', () => {
  const view = parsePeerLedger(env(report({
    pairs: [{ fromAgent: 'd\u001b[31mot\u0000', target: 'x'.repeat(100), inWindow: 1, remaining: 2, lastAt: 'x' }],
  })));
  expect(view?.pairs[0]?.fromAgent).toBe('d[31mot');
  expect(view?.pairs[0]?.target).toHaveLength(64);
});
it('reads unavailable as unknown, never zero', () => {
  const view = parsePeerLedger(env(report({ status: 'unavailable', reason: 'peer-ledger-unreadable', liveRows: 0 })));
  expect(peerLedgerHeadline(view!)).toBe('Peer bus: unknown (peer-ledger-unreadable)');
});
it('reads empty as no live traffic', () => {
  const view = parsePeerLedger(env(report({ status: 'empty', pairs: [], origins: [], liveRows: 0 })));
  expect(peerLedgerHeadline(view!)).toBe('Peer bus: no live peer traffic');
});
