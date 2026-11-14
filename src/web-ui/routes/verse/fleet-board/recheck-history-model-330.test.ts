/** RQ-PHX-RECHECKHISTSTRIP330 — pure history derivation. Fake data only. */
import { expect, it } from 'vitest';
import { deriveRecheckHistory } from './recheck-history-model.js';

const NOW = Date.parse('2026-11-14T12:00:00Z');
const at = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString();
const row = (minsAgo: number, overall: string, over: Record<string, string> = {}) => ({
  asOf: at(minsAgo), overall,
  sections: Object.fromEntries(['runtime', 'claims', 'bridge', 'task'].map((n) => [n, { state: over[n] ?? overall, asOf: at(minsAgo), host: 'host-a.example' }])),
});
const resp = (rows: unknown[], extra: Record<string, unknown> = {}) => ({ history: { rows, skipped: 0, missing: false, ...extra } });

it('describes a BLOCKED run with duration and count', () => {
  const v = deriveRecheckHistory(resp([row(1, 'BLOCKED'), row(60, 'BLOCKED'), row(180, 'BLOCKED'), row(240, 'VERIFIED')]), NOW);
  expect(v.held).toMatch(/^BLOCKED for 3h \(since \d\d:\d\d, 3 checks\)$/);
});

it('appends "or longer" when the run fills the window', () => {
  const v = deriveRecheckHistory(resp([row(1, 'BLOCKED'), row(120, 'BLOCKED')]), NOW);
  expect(v.held).toMatch(/2 checks\) or longer$/);
});

it('names the sections that changed, newest first', () => {
  const v = deriveRecheckHistory(resp([
    row(120, 'BLOCKED', { runtime: 'VERIFIED', claims: 'VERIFIED', task: 'VERIFIED' }),
    row(300, 'UNKNOWN', { runtime: 'VERIFIED', claims: 'VERIFIED', task: 'VERIFIED' }),
    row(400, 'UNKNOWN', { runtime: 'VERIFIED', claims: 'VERIFIED', task: 'VERIFIED' }),
  ]), NOW);
  expect(v.changes).toEqual([{ asOf: at(120), text: 'bridge UNKNOWN → BLOCKED, overall UNKNOWN → BLOCKED · 2h ago' }]);
});

it('caps transitions at five', () => {
  const rows = Array.from({ length: 12 }, (_, i) => row(i * 10 + 1, i % 2 ? 'BLOCKED' : 'VERIFIED'));
  expect(deriveRecheckHistory(resp(rows), NOW).changes).toHaveLength(5);
});

it('skips and counts malformed rows', () => {
  const v = deriveRecheckHistory(resp([row(1, 'BLOCKED'), null, { asOf: 'nope', overall: 'BLOCKED' }, 'x'], { skipped: 2 }), NOW);
  expect(v.note).toBe('5 unreadable rows skipped');
  expect(v.held).toMatch(/^BLOCKED/);
});

it('prints unknown states as unreadable, never inventing one', () => {
  const v = deriveRecheckHistory(resp([row(1, 'WEIRD'), row(30, 'BLOCKED')]), NOW);
  expect(v.held).toMatch(/^unreadable for/);
  expect(v.changes[0]!.text).toContain('overall BLOCKED → unreadable');
});

it('handles null / malformed payloads', () => {
  expect(deriveRecheckHistory(null, NOW).held).toBe('Recheck history unreadable');
  expect(deriveRecheckHistory({}, NOW).held).toBe('Recheck history unreadable');
  expect(deriveRecheckHistory(resp('nope' as never), NOW).held).toBe('Recheck history unreadable');
});

it('reports an empty log', () => {
  expect(deriveRecheckHistory(resp([], { missing: true }), NOW)).toEqual({ held: 'No recorded rechecks yet', changes: [], note: null });
  expect(deriveRecheckHistory(resp([], { missing: false }), NOW).held).toBe('Recheck history unreadable');
});
