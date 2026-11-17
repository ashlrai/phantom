/** RQ-PHX-RECHECKNOWBUTTON340 — describeRecheckNow maps every outcome to one line. */
import { expect, it } from 'vitest';
import { describeRecheckNow } from './recheck-now-model.js';

const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const asOf = new Date(NOW - 5 * 60_000).toISOString();

it('describes a recorded verdict', () => {
  expect(describeRecheckNow({ ok: true, recorded: { overall: 'BLOCKED', asOf } }, NOW)).toBe('Recorded BLOCKED as of 5m ago');
});

it('maps each status to its line', () => {
  expect(describeRecheckNow({ ok: false, status: 409 })).toBe('A recheck is already running');
  expect(describeRecheckNow({ ok: false, status: 503 })).toBe('Recheck unavailable right now');
  expect(describeRecheckNow({ ok: false, status: 404 })).toBe('Recheck now is not on this Phantom build');
  expect(describeRecheckNow({ ok: false, status: 405 })).toBe('Recheck now is not on this Phantom build');
  expect(describeRecheckNow({ ok: false, status: 500, reason: 'disk full' })).toBe('Record failed: disk full');
  expect(describeRecheckNow({ ok: false, status: 500 })).toBe('Record failed: unknown reason');
});

it.each([undefined, null, 'x', {}, { overall: 'GREAT', asOf }, { overall: 7 }])('treats malformed 200 payload %j as failure text', (recorded) => {
  expect(describeRecheckNow({ ok: true, recorded }, NOW)).toMatch(/^Record failed: /);
});

it('truncates a long reason to 120 characters', () => {
  const line = describeRecheckNow({ ok: false, status: 500, reason: 'x'.repeat(400) });
  expect(line).toBe(`Record failed: ${'x'.repeat(120)}`);
});
