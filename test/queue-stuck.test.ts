import { describe, expect, it } from 'vitest';
import { stuckJobs } from '../src/core/queue/stuck.js';

describe('waiting router jobs', () => {
  it('uses enqueue time, then first dispatch evidence, otherwise unknown, excluding launches', () => {
    const now = new Date('2026-01-01T00:10:00').getTime();
    const epoch = Math.floor(now / 1000) - 30;
    const queue = `- READY RQ-A (enq=${epoch}): task\n- READY RQ-B (pool=x): task\n- READY RQ-C (pool=x): task\n- READY RQ-D (pool=x): task\n`;
    const events = '2026-01-01 00:08:00 SEEN RQ-A RQ-B\n2026-01-01 00:09:00 SEEN RQ-B\n2026-01-01 00:09:00 LAUNCH RQ-D repo lane work\n';
    expect(stuckJobs(queue, events, now)).toEqual([{ id: 'RQ-A', age_s: 30 }, { id: 'RQ-B', age_s: 120 }, { id: 'RQ-C', age: 'unknown' }]);
  });
});
