import { expect, it } from 'vitest';
import { visitDelta, type VisitMark } from '../fleet/visit-delta.js';
import { sinceVisitLine } from './fleet-brief-model.js';

const previous: VisitMark = { at: 0, merged24h: 4, inboxCount: 1, workers: 2, personalPct: 24 };
const now = 15 * 60_000;

it('omits the line on a first visit', () => {
  expect(sinceVisitLine(visitDelta(null, { ...previous, at: now }), now)).toBeNull();
});

it('formats the shared mixed visit delta', () => {
  const current = { at: now, merged24h: 7, inboxCount: 3, workers: 3, personalPct: 18 };
  expect(sinceVisitLine(visitDelta(previous, current), now)).toBe(
    'Since you last looked (15 min ago): +3 merges · +2 inbox · 3 workers now · codex-personal 24% → 18%',
  );
});

it('reports when nothing changed', () => {
  expect(sinceVisitLine(visitDelta(previous, { ...previous, at: now }), now))
    .toBe('Since you last looked (15 min ago): nothing changed');
});
