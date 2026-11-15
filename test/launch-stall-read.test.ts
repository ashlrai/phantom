import { describe, expect, it } from 'vitest';
import { parseLaunchStall } from '../src/core/fleet/launch-stall-read.js';

const tick = (at: string, q: number, launched: number, reap = 0) => `${at} tick run={"devin":0} q=${q} launched=${launched} reap=${reap}`;
const log = (...lines: string[]) => `${lines.join('\n')}\n`;

describe('parseLaunchStall', () => {
  it('reports a queued run with no launches, first to last tick', () => {
    const report = parseLaunchStall(log(
      tick('2026-11-09 10:00:00', 5, 2),
      tick('2026-11-09 10:01:00', 37, 0, 1),
      'unrelated line',
      tick('2026-11-09 10:43:00', 37, 0, 2),
    ), 30);
    expect(report).toMatchObject({ minutes: 42, lastQ: 37, lastReap: 2, min: 30, stalled: true });
    expect(report.startTime).toMatch(/^2026-11-09T10:01:00/);
  });

  it('a launching tick resets the run', () => {
    expect(parseLaunchStall(log(
      tick('2026-11-09 10:00:00', 5, 0),
      tick('2026-11-09 11:00:00', 5, 1),
    ), 30)).toEqual({ startTime: null, minutes: null, lastQ: null, lastReap: null, min: 30, stalled: false });
    const after = parseLaunchStall(log(
      tick('2026-11-09 10:00:00', 5, 0),
      tick('2026-11-09 11:00:00', 5, 1),
      tick('2026-11-09 11:10:00', 4, 0),
    ), 30);
    expect(after).toMatchObject({ minutes: 0, lastQ: 4, stalled: false });
  });

  it('malformed tick lines and empty queues reset the run', () => {
    const base = tick('2026-11-09 10:00:00', 5, 0);
    for (const bad of [
      '2026-11-09 10:30:00 tick run={} q=five launched=0 reap=0',
      '2026-13-40 10:30:00 tick run={} q=5 launched=0 reap=0',
      tick('2026-11-09 10:30:00', 0, 0),
    ]) {
      expect(parseLaunchStall(log(base, bad, tick('2026-11-09 10:45:00', 5, 0)), 10)).toMatchObject({ minutes: 0, stalled: false });
    }
  });

  it('a clock going backwards restarts the run at that tick', () => {
    const report = parseLaunchStall(log(
      tick('2026-11-09 10:00:00', 5, 0),
      tick('2026-11-09 11:00:00', 5, 0),
      tick('2026-11-09 09:00:00', 6, 0),
      tick('2026-11-09 09:20:00', 6, 0),
    ), 30);
    expect(report).toMatchObject({ minutes: 20, lastQ: 6, stalled: false });
    expect(report.startTime).toMatch(/^2026-11-09T09:00:00/);
  });

  it('an empty log reports no run', () => {
    expect(parseLaunchStall('', 30)).toEqual({ startTime: null, minutes: null, lastQ: null, lastReap: null, min: 30, stalled: false });
  });
});
