import { describe, expect, it } from 'vitest';
import type { RunsSample } from '../../../../core/fleet/runs-history.js';
import { fleetMoment, fleetMomentWords, laneMoment, laneMomentWords, nearestSample, processWords, sampleWords, sampleX, stepSample } from './capacity-cursor-model.js';

const sample = (over: Partial<RunsSample> = {}): RunsSample => ({
  at: '2026-11-20T15:40:00.000Z', workers: 12, leaders: 2, paused: false,
  lanes: [
    { lane: 'alpha', running: 2, target: 2, queued: 0, held: false },
    { lane: 'codex-personal', running: 18, target: 24, queued: 8, held: false },
    { lane: 'devin', running: 1, target: 4, queued: 0, held: true },
  ],
  ...over,
});
const at = (...ms: number[]) => ms.map((atMs) => ({ atMs }));

describe('nearestSample', () => {
  it('picks the sample taken nearest, the later one on a tie', () => {
    expect(nearestSample(at(0, 100, 200), 40)).toBe(0);
    expect(nearestSample(at(0, 100, 200), 60)).toBe(1);
    expect(nearestSample(at(0, 100, 200), 50)).toBe(1);
    expect(nearestSample(at(0, 100, 200), 9_999)).toBe(2);
    expect(nearestSample(at(0, 100, 200), -5)).toBe(0);
  });
  it('has nothing to pick without samples', () => {
    expect(nearestSample([], 10)).toBe(-1);
  });
});

describe('stepSample', () => {
  it('steps one sample with the arrows and stops at the ends', () => {
    expect(stepSample('ArrowLeft', 3, 7)).toBe(2);
    expect(stepSample('ArrowRight', 3, 7)).toBe(4);
    expect(stepSample('ArrowLeft', 0, 7)).toBe(0);
    expect(stepSample('ArrowRight', 6, 7)).toBe(6);
  });
  it('moves a tenth of the window with the page keys, at least one sample', () => {
    expect(stepSample('PageDown', 100, 240)).toBe(76);
    expect(stepSample('PageUp', 230, 240)).toBe(239);
    expect(stepSample('PageDown', 3, 7)).toBe(2);
  });
  it('jumps to the oldest and newest', () => {
    expect(stepSample('Home', 3, 7)).toBe(0);
    expect(stepSample('End', 3, 7)).toBe(6);
  });
  it('leaves every other key alone', () => {
    expect(stepSample('[', 3, 7)).toBeNull();
    expect(stepSample(']', 3, 7)).toBeNull();
    expect(stepSample('a', 3, 7)).toBeNull();
    expect(stepSample('ArrowLeft', 0, 0)).toBeNull();
  });
});

describe('a lane at one sample', () => {
  it('reads running against target, queued and the hold', () => {
    expect(laneMomentWords(laneMoment(sample(), 'codex-personal'))).toBe('18 of 24 running, 8 queued');
    expect(laneMomentWords(laneMoment(sample(), 'devin'))).toBe('1 of 4 running, 0 queued, held');
  });
  it('says a lane the sample does not name was not reported, never zero', () => {
    expect(laneMoment(sample(), 'grok')).toBeNull();
    expect(laneMoment(undefined, 'alpha')).toBeNull();
    expect(laneMomentWords(null)).toBe('not reported in this sample');
  });
  it('says no target instead of "of 0"', () => {
    expect(laneMomentWords({ running: 3, target: 0, queued: 1, held: false })).toBe('3 running, no target, 1 queued');
  });
});

describe('the fleet at one sample', () => {
  it('adds up the lanes the sample names', () => {
    expect(fleetMoment(sample())).toEqual({ lanes: 3, running: 21, target: 30, queued: 8, held: 1, paused: false });
    expect(fleetMomentWords(fleetMoment(sample()))).toBe('21 of 30 slots running across 3 lanes, 8 queued, 1 lane held');
  });
  it('says when the fleet was paused, and only when the sample says so', () => {
    expect(fleetMomentWords(fleetMoment(sample({ paused: true })))).toMatch(/, fleet paused$/);
    expect(fleetMomentWords(fleetMoment(sample({ paused: null })))).not.toMatch(/paused/);
  });
  it('claims nothing for a sample with no lanes', () => {
    expect(fleetMomentWords(fleetMoment(sample({ lanes: [] })))).toBe('no lane reported');
  });
  it('uses the singular for one lane and one slot', () => {
    expect(fleetMomentWords(fleetMoment(sample({ lanes: [{ lane: 'alpha', running: 1, target: 1, queued: 0, held: false }] })))).toBe('1 of 1 slot running across 1 lane, 0 queued');
  });
});

describe('processWords', () => {
  it('counts workers and leaders', () => {
    expect(processWords(sample())).toBe('12 workers, 2 leaders');
    expect(processWords(sample({ workers: 1, leaders: 1 }))).toBe('1 worker, 1 leader');
  });
  it('keeps a missing count unknown', () => {
    expect(processWords(sample({ workers: null }))).toBe('workers unknown, 2 leaders');
    expect(processWords(sample({ leaders: null }))).toBe('12 workers, leaders unknown');
    expect(processWords(undefined)).toBe('not reported in this sample');
  });
});

describe('placing and naming a sample', () => {
  it('places a sample between the first and the last', () => {
    expect(sampleX(at(0, 50, 200), 0)).toBe(0);
    expect(sampleX(at(0, 50, 200), 1)).toBe(25);
    expect(sampleX(at(0, 50, 200), 2)).toBe(100);
  });
  it('puts a lone sample at the start and places nothing outside the samples', () => {
    expect(sampleX(at(70), 0)).toBe(0);
    expect(sampleX(at(0, 50), 2)).toBeNull();
    expect(sampleX([], 0)).toBeNull();
  });
  it('says a sample in full', () => {
    expect(sampleWords(2, 7, 'Nov 20, 3:40 PM', '18 of 24 running, 8 queued')).toBe('Sample 3 of 7, Nov 20, 3:40 PM: 18 of 24 running, 8 queued');
  });
});
