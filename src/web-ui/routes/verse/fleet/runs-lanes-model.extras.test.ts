import { expect, it } from 'vitest';
import { etaText, nextPassEta } from './next-pass-eta.js';
import { headerExtras, narrowRunsLanes } from './runs-lanes-model.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const snapshot = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', lastTick: null, paused: false, switches: [],
  sources: { runsDir: 'healthy' }, lanes: [],
  leaders: [{ label: 'older', ageSeconds: 600 }, { label: 'newest', ageSeconds: 240 }],
  codexPersonal: { usedPct: 92, resetsAt: '2026-11-05T04:00:00Z', asOf: '2026-10-31T12:00:00Z' },
};

it('shows the newest leader pass and personal usage with the New York reset date', () => {
  expect(headerExtras(narrowRunsLanes(snapshot)!, now)).toEqual(['next leader pass in ~11 min', 'personal Codex 92%, resets Nov 4']);
  expect(headerExtras(narrowRunsLanes(snapshot)!, now + 60_000)[0]).toBe('next leader pass in ~10 min');
});
it('shows personal usage alone without a finite leader age', () => {
  expect(headerExtras(narrowRunsLanes({ ...snapshot, leaders: [{ label: 'unknown', ageSeconds: null }] })!, now))
    .toEqual(['personal Codex 92%, resets Nov 4']);
  expect(headerExtras(narrowRunsLanes({ ...snapshot, leaders: 'bad' })!, now)).toEqual(['personal Codex 92%, resets Nov 4']);
});
it('shows the pass alone when personal usage is unavailable or malformed', () => {
  for (const codexPersonal of [null, { ...snapshot.codexPersonal, usedPct: null }, { ...snapshot.codexPersonal, usedPct: Infinity }]) {
    expect(headerExtras(narrowRunsLanes({ ...snapshot, codexPersonal })!, now)).toEqual(['next leader pass in ~11 min']);
  }
});
it('uses the shared overdue formatter', () => {
  const overdue = now + 20 * 60_000;
  const sharedText = etaText(nextPassEta(now - 240_000, overdue));
  expect(headerExtras(narrowRunsLanes({ ...snapshot, codexPersonal: null })!, overdue))
    .toEqual([sharedText.replace('pass overdue', 'leader pass overdue')]);
});
it('omits a reset date that cannot be parsed', () => {
  expect(headerExtras(narrowRunsLanes({ ...snapshot, leaders: [], codexPersonal: { ...snapshot.codexPersonal, resetsAt: 'bad' } })!, now))
    .toEqual(['personal Codex 92%']);
});
