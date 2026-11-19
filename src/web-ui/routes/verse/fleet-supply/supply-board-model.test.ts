import { expect, it } from 'vitest';
import { boardHeadline, MAX_MARKS, supplyCard, supplyStrip, totalsLine, wasteBar } from './supply-board-model.js';
import { laneSupply } from './supply-model.js';
import { supplyFixture } from './supply-fixture.js';

const cards = (pendingKnown = true) => laneSupply(supplyFixture()).map(row => supplyCard(row, pendingKnown));

it('sets each lane\'s opening slots against the jobs waiting for them', () => {
  const [active, over, held] = cards();
  expect(active).toMatchObject({ lane: 'active', state: 'short', stateText: '4 short', waiting: 3, covered: 3, spare: 0 });
  expect(active.marks).toEqual(['covered', 'covered', 'covered', 'short', 'short', 'short', 'short']);
  expect(active.facts.map(fact => fact.value)).toEqual(['3/8', '5', '2', '3', '4']);
  expect(over).toMatchObject({ state: 'short', stateText: '1 short', marks: ['short'] });
  expect(held).toMatchObject({ state: 'held', stateText: 'Held, not counted' });
  expect(held.facts.at(-1)).toEqual({ label: 'Shortfall', value: 'none while held' });
});

it('counts spare jobs, a lane with nothing opening and a lane too large for marks', () => {
  const base = { lane: 'a', running: 2, target: 2, queued: 5, held: false, heldReason: null, freeNow: 0, freeingSoon: 2, pendingFiles: 0, demand: 2, shortfall: 0 };
  expect(supplyCard(base, true)).toMatchObject({ state: 'supplied', stateText: 'Supplied', covered: 2, spare: 3, coveredPct: 100 });
  expect(supplyCard({ ...base, freeingSoon: 0, demand: 0 }, true)).toMatchObject({ state: 'quiet', stateText: 'No slots opening', marks: null, coveredPct: null });
  const large = supplyCard({ ...base, demand: MAX_MARKS + 8, queued: 10, shortfall: MAX_MARKS - 2 }, true);
  expect(large.marks).toBeNull();
  expect(large.coveredPct).toBe(25);
});

it('never lets uncounted job files cover a slot', () => {
  // The fixture still lists two files for the lane; with the folder unread they are not trusted.
  const [active, , held] = cards(false);
  expect(active).toMatchObject({ pendingFiles: 0, waiting: 1, covered: 1, shortfall: 6, stateText: 'up to 6 short' });
  expect(active.facts.slice(-2).map(fact => fact.value)).toEqual(['1 queued, files unknown', 'up to 6']);
  expect(active.picture).toBe('active: 1 of 7 opening slots has a job waiting (job files not counted)');
  expect(held.shortfall).toBe(0);
  expect(boardHeadline(cards(false), false)).toBe('Write up to 7 more job files · Shortfall up to 7 slots');
  expect(totalsLine(cards(false), false)).toBe('8 slots open within 15 min · 1 queued, job files unknown · 1 lane held');
});

it('writes the headline and the totals line', () => {
  expect(boardHeadline(cards(), true)).toBe('Write 5 more job files · Shortfall 5 slots');
  expect(boardHeadline(cards().map(card => ({ ...card, shortfall: 0 })), false)).toBe('Lanes are supplied');
  expect(boardHeadline(cards().filter(card => card.held), true)).toBe('All lanes held');
  expect(totalsLine(cards(), true)).toBe('8 slots open within 15 min · 3 jobs waiting · 1 lane held');
  expect(totalsLine([], true)).toBeNull();
});

it('lays the open lanes end to end and leaves held ones out', () => {
  const strip = supplyStrip(cards());
  expect(strip?.label).toBe('3 of 8 opening slots have a job waiting');
  expect(strip?.segments.map(segment => [segment.lane, segment.weight])).toEqual([['active', 7], ['over', 1]]);
  expect(supplyStrip(cards().filter(card => card.held))).toBeNull();
});

it('splits a weekly window into used, burn by reset and unused', () => {
  expect(wasteBar(40, 20, true)).toMatchObject({ usedPct: 40, burnPct: 40, unusedPct: 20, label: '40% used, 40% more by reset at the current burn, 20% unused' });
  expect(wasteBar(40, 60, false)?.label).toBe('40% used, burn unknown, 60% unused');
  expect(wasteBar(null, 60, true)).toBeNull();
});
