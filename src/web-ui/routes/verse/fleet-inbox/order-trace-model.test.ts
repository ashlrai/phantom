import { describe, expect, it } from 'vitest';
import { githubUrl, jobsForEntry, narrowOrderTrace, orderJobsLine, stateWord } from './order-trace-model.js';
import type { OrderTraceJob } from './order-trace-model.js';

const job: OrderTraceJob = { id: 'RQ-PHX-TEST', lane: 'work', state: 'published', url: 'https://github.com/ashlrai/phantom/pull/1938' };
const wire = { v: 1, generatedAt: 'now', sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' },
  orders: [{ at: '2026-10-31 00:13 ET', source: 'desktop', key: '10-31 00:13', jobs: [job] }] };

describe('order traces', () => {
  it('narrows the wire shape and rejects malformed data', () => {
    expect(narrowOrderTrace(wire)).toEqual(wire);
    expect(narrowOrderTrace(null)).toBeNull();
    expect(narrowOrderTrace({ ...wire, v: 2 })).toBeNull();
    expect(narrowOrderTrace({ ...wire, orders: [{ ...wire.orders[0], jobs: [{ ...job, state: 'unknown' }] }] })).toBeNull();
  });
  it('matches exact timestamps before falling back to the month-day key', () => {
    const trace = narrowOrderTrace(wire);
    expect(jobsForEntry(trace, '2026-10-31 00:13 ET')).toEqual([job]);
    expect(jobsForEntry(trace, '2026-10-31 00:13')).toEqual([job]);
    expect(jobsForEntry(trace, '2026-10-31 00:14')).toEqual([]);
    expect(jobsForEntry(trace, '—')).toEqual([]);
    expect(jobsForEntry(null, '2026-10-31 00:13')).toEqual([]);
    const exact = narrowOrderTrace({ ...wire, orders: [...wire.orders, { ...wire.orders[0], at: '2026-10-31 00:13', jobs: [] }] });
    expect(jobsForEntry(exact, '2026-10-31 00:13')).toEqual([]);
  });
  it('formats counts and states and accepts only safe GitHub links', () => {
    expect(orderJobsLine([])).toBe('');
    expect(orderJobsLine([job])).toBe('1 job');
    expect(orderJobsLine([job, job, job])).toBe('3 jobs');
    expect(stateWord(job)).toBe('PR #1938');
    expect(stateWord({ ...job, state: 'queued' })).toBe('queued');
    expect(stateWord({ ...job, state: 'launched' })).toBe('running');
    expect(stateWord({ ...job, url: null })).toBe('published');
    expect(githubUrl({ ...job, url: 'https://github.com.evil.test/a/b/pull/1' })).toBeNull();
    expect(githubUrl({ ...job, url: 'javascript:alert(1)' })).toBeNull();
  });
});
