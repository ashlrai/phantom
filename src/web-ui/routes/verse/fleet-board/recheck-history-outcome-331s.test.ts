import { expect, it } from 'vitest';
import { deriveRecheckHistory } from './recheck-history-model.js';

const now = Date.parse('2026-11-14T12:00:00Z');
const row = (minutes: number, state: string) => ({
  asOf: new Date(now - minutes * 60_000).toISOString(), overall: state,
  sections: Object.fromEntries(['runtime', 'claims', 'bridge', 'task'].map((name) => [name, { state }])),
});
const history = (rows: unknown, extra: Record<string, unknown> = {}) => ({
  history: { rows, skipped: 0, missing: false, ...extra },
});

it('reports explicit unreadable even with valid rows and hides failure text', () => {
  expect(deriveRecheckHistory(history([row(10, 'BLOCKED')], { outcome: 'unreadable', failure: 'private detail' }), now))
    .toEqual({ held: 'Recheck history unreadable', changes: [], note: null });
});

it('distinguishes successful empty, missing, and legacy histories', () => {
  expect(deriveRecheckHistory(history([], { outcome: 'ok' }), now).held).toBe('Recheck history is empty');
  expect(deriveRecheckHistory(history([], { outcome: 'ok', missing: true }), now).held).toBe('No recorded rechecks yet');
  expect(deriveRecheckHistory(history([]), now).held).toBe('Recheck history unreadable');
  expect(deriveRecheckHistory(history([], { missing: true }), now).held).toBe('No recorded rechecks yet');
});

it('does not call malformed or skipped histories empty', () => {
  for (const input of [history(null, { outcome: 'ok' }), history([null], { outcome: 'ok' }), history([], { outcome: 'ok', skipped: 1 })]) {
    expect(deriveRecheckHistory(input, now).held).toBe('Recheck history unreadable');
  }
});

it('retains valid row durations and transitions', () => {
  const view = deriveRecheckHistory(history([row(10, 'BLOCKED'), row(120, 'VERIFIED')], { outcome: 'ok' }), now);
  expect(view.held).toMatch(/^BLOCKED for 10m \(since \d\d:\d\d, 1 check\)$/);
  expect(view.changes).toHaveLength(1);
  expect(view.changes[0]?.text).toContain('overall VERIFIED → BLOCKED');
});
