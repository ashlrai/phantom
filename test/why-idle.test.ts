import { expect, it } from 'vitest';
import { whyIdle, type WhyIdleBrief } from '../src/core/fleet/why-idle.js';
const at = '2026-11-21T12:00:00Z';
const lane = { lane: 'codex', running: 1, target: 4, held: false, queuedReady: 0 };
const pool = { pool: 'claude', usedPct: 82, verdict: 'over' };
const fixtures: [string, WhyIdleBrief, string][] = [
  ['hold', { at, lanes: [{ ...lane, held: true }] }, 'Codex on hold: 1 running'],
  ['pause', { at, lanes: [{ ...lane, lane: 'claude', pause_new_until: Date.parse(at) / 1000 + 3600 }], pools: [pool] }, 'Claude paused until Sat 1:00 PM UTC: 1 running; 82% used, spending too fast'],
  ['pace', { at, pools: [pool] }, 'Claude: 82% used, spending too fast'],
  ['settling', { at, admission: { lastWhy: 'settle after launch', settleSeconds: 300 } }, 'Starts spaced about 5 min apart after load spikes'],
  ['host', { at, admission: { lastWhy: 'over_host', startsPerHour: 6 } }, 'Computer too busy: 0 new starts, 6 starts per hour recently'],
  ['owned', { at, admission: { lastWhy: 'over_owned' } }, 'Computer too busy: 0 new starts'],
  ['queue', { at, lanes: [lane] }, 'Codex: 3 free spots, 0 ready jobs'],
  ['stuck', { at, attention: [{ lane: 'codex-local', status: 'stuck' }, { lane: 'local', status: 'stuck' }] }, 'Local models: 2 stuck jobs'],
];
it.each(fixtures)('explains %s in one plain line with numbers', (_kind, brief, expected) => {
  const before = JSON.stringify(brief);
  expect(whyIdle(brief)).toEqual([expected]);
  expect(JSON.stringify(brief)).toBe(before);
  expect(expected).not.toMatch(/lane|admission|settle_s|\n/i);
  expect(expected).toMatch(/\d/);
});
it('ranks and caps reasons, combining pause and spending without repeating the pool', () => {
  expect(whyIdle({ at, lanes: [{ ...lane, lane: 'claude', held: true }, lane], pools: [pool], admission: { lastWhy: 'settle', settleSeconds: 60 }, attention: [{ lane: 'local', status: 'stuck' }] })).toEqual([
    'Claude on hold: 1 running; 82% used, spending too fast',
    'Starts spaced about 1 min apart after load spikes', 'Codex: 3 free spots, 0 ready jobs',
  ]);
});
it('returns no reasons for full capacity, unknown readings, expired pauses or quiet jobs', () => {
  expect(whyIdle({ at, lanes: [{ ...lane, running: 4 }], pools: [pool] })).toEqual([]);
  expect(whyIdle({ at, lanes: [{ ...lane, running: null, target: null, queuedReady: null }], pools: [{ ...pool, verdict: 'unknown' }], admission: { lastWhy: 'open', settleSeconds: 300 }, attention: [{ lane: 'local', status: 'quiet' }] })).toEqual([]);
  expect(whyIdle({ at, lanes: [{ ...lane, queuedReady: 1, pause_new_until: Date.parse(at) / 1000 - 1 }] })).toEqual([]);
  expect(whyIdle({ at })).toEqual([]);
});
