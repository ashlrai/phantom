import { describe, expect, it } from 'vitest';
import { HORIZON_SECONDS, laneSupply, supplyHeadline, totalShortfall, TYPICAL_RUN_SECONDS } from './supply-model.js';

import { supplyFixture } from './supply-fixture.js';

describe('lane supply', () => {
  it('calculates demand, waiting and shortfall per lane and sorts by shortfall', () => {
    const rows = laneSupply(supplyFixture());
    expect(rows.map(row => row.lane)).toEqual(['active', 'over', 'held']);
    expect(rows[0]).toMatchObject({ freeNow: 5, freeingSoon: 2, pendingFiles: 2, queued: 1, demand: 7, shortfall: 4 });
    expect(rows[1]).toMatchObject({ freeNow: 0, freeingSoon: 1, shortfall: 1 });
    expect(rows[2]).toMatchObject({ freeNow: 8, freeingSoon: 1, shortfall: 0, heldReason: 'Quota exhausted' });
    expect(totalShortfall(rows)).toBe(5);
    expect(supplyHeadline(rows)).toBe('Write 5 more job files');
  });

  it('counts the horizon boundary, excludes unknown and invalid ages, and ignores other lanes', () => {
    const fixture = supplyFixture();
    const threshold = TYPICAL_RUN_SECONDS - HORIZON_SECONDS;
    fixture.workers = [
      { lane: 'active', ageSeconds: threshold }, { lane: 'active', ageSeconds: threshold - 1 },
      { lane: 'active', ageSeconds: null }, { lane: 'active', ageSeconds: NaN },
      { lane: 'active', ageSeconds: Infinity }, { lane: 'unknown', ageSeconds: 1000 },
    ];
    expect(laneSupply(fixture)[0].freeingSoon).toBe(1);
  });

  it('uses lane name to break ties and handles supplied, held and empty headlines', () => {
    const fixture = supplyFixture();
    fixture.lanes = fixture.lanes.map(lane => ({ ...lane, running: 8, target: 8, queued: 10 }));
    const rows = laneSupply(fixture);
    expect(rows.map(row => row.lane)).toEqual(['active', 'held', 'over']);
    expect(supplyHeadline(rows)).toBe('Lanes are supplied');
    expect(supplyHeadline(rows.map(row => ({ ...row, held: true })))).toBe('All lanes held');
    expect(supplyHeadline([])).toBe('Lanes are supplied');
  });

  it.each([null, undefined, 42, 'bad', [], {}, { lanes: null }, { lanes: [null, {}, { lane: 1 }] }])('ignores malformed input %j', snapshot => {
    expect(laneSupply(snapshot)).toEqual([]);
  });

  it('tolerates malformed nested values and clamps invalid counts', () => {
    expect(laneSupply({ lanes: [{ lane: 'safe', running: -1, target: Infinity, queued: 'bad' }], workers: [null], drop: { pending: [null] } }))
      .toEqual([{ lane: 'safe', running: 0, target: 0, queued: 0, held: false, heldReason: null, freeNow: 0, freeingSoon: 0, pendingFiles: 0, demand: 0, shortfall: 0 }]);
  });
});
