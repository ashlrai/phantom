import { describe, expect, it } from 'vitest';
import { describeHostLoad, hostLoadTone, readHostLoad } from './host-load.js';

describe('host load', () => {
  it('reads all averages and rounds the one-minute load per core', () => {
    const load = readHostLoad({ loadavg: () => [194, 180, 160], cpus: () => Array(18).fill({}) });
    expect(load).toEqual({ load1: 194, load5: 180, load15: 160, cores: 18, ratio: 10.8 });
    expect(describeHostLoad(load)).toBe('Load 194 on 18 cores (10.8×)');
  });
  it.each([[null, 'unknown'], [0, 'ok'], [1.49, 'ok'], [1.5, 'warn'], [3.99, 'warn'], [4, 'bad']] as const)(
    'classifies ratio %s as %s', (ratio, tone) => expect(hostLoadTone(ratio)).toBe(tone),
  );
  it('preserves available readings when a dependency fails and rejects invalid values', () => {
    const fail = () => { throw new Error('unavailable'); };
    expect(readHostLoad({ loadavg: fail, cpus: fail })).toEqual({ load1: null, load5: null, load15: null, cores: null, ratio: null });
    expect(readHostLoad({ loadavg: () => [1, NaN, -1], cpus: () => [] })).toEqual({ load1: 1, load5: null, load15: null, cores: null, ratio: null });
    expect(describeHostLoad(null)).toBe('Load unknown');
  });
});
