import { describe, expect, it } from 'vitest';
import { laneDeadSignals } from '../src/core/fleet/lane-dead-signal.js';

const finish = (index: number, overrides: Record<string, unknown> = {}) => ({ event: 'finish', lane: 'any-lane', empty: true, exit_code: 1, ts: new Date(1_000 * index).toISOString(), ...overrides });
const failures = (count: number) => Array.from({ length: count }, (_, index) => finish(index));

describe('lane dead signal', () => {
  it('marks eight consecutive empty failures dead and caps the window', () => {
    expect(laneDeadSignals(failures(9)).lanes).toEqual([{ lane: 'any-lane', lastFinishes: 8, emptyFailures: 8, state: 'dead' }]);
  });
  it('resets the streak on success even when rows are out of order', () => {
    expect(laneDeadSignals([finish(8, { empty: false, exit_code: 0 }), ...failures(7)]).lanes[0]).toMatchObject({ lastFinishes: 8, emptyFailures: 0, state: 'ok' });
  });
  it('marks four consecutive failures suspect and separates lanes', () => {
    expect(laneDeadSignals([...failures(4), finish(0, { lane: 'another', empty: false })]).lanes).toEqual([
      { lane: 'any-lane', lastFinishes: 4, emptyFailures: 4, state: 'suspect' },
      { lane: 'another', lastFinishes: 1, emptyFailures: 0, state: 'ok' },
    ]);
  });
  it('does not count an empty exit zero as a failure', () => {
    expect(laneDeadSignals([...failures(4), finish(5, { exit_code: 0 })]).lanes[0]).toMatchObject({ emptyFailures: 0, state: 'ok' });
  });
  it('counts malformed rows, skips other events, and returns no lanes without finishes', () => {
    expect(laneDeadSignals([null, { event: 'finish', lane: 'x' }, { event: 'start' }])).toEqual({ lanes: [], malformedRows: 2 });
  });
});
