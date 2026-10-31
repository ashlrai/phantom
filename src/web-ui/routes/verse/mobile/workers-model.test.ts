import { describe, expect, it } from 'vitest';
import { isFleetWorkers, workerRows } from './workers-model.js';

const worker = (job: string, ageSeconds: number | null) => ({ job, lane: 'lane-a', tier: 'work', ageSeconds });
const now = Date.parse('2026-01-01T12:00:00Z');

describe('fleet workers model', () => {
  it('accepts the needed fields and tolerates additional fields', () => {
    expect(isFleetWorkers({ workers: [{ ...worker('RQ-1', 10), repo: 'fake-repo' }], v: 1 })).toBe(true);
  });

  it('rejects malformed payloads and invalid ages', () => {
    for (const value of [null, [], {}, { workers: null }, { workers: [{}] },
      { workers: [{ ...worker('RQ-1', 1), lane: 1 }] },
      { workers: [{ ...worker('RQ-1', 1), job: null }] },
      { workers: [{ ...worker('RQ-1', 1), tier: false }] },
      ...[-1, Infinity, NaN, '10', undefined].map(ageSeconds => ({ workers: [{ ...worker('RQ-1', 1), ageSeconds }] }))]) {
      expect(isFleetWorkers(value)).toBe(false);
    }
  });

  it('orders known ages oldest first, puts unknown last and reports the oldest', () => {
    const view = workerRows({ workers: [worker('unknown', null), worker('new', 60), worker('old', 3_600)] }, now);
    expect(view.rows.map(row => row.job)).toEqual(['old', 'new', 'unknown']);
    expect(view.rows.map(row => row.ageText)).toEqual(['1 h', '1 min', 'unknown']);
    expect(view.summary).toBe('3 running · oldest old 1 h');
    expect(workerRows({ workers: [worker('unknown', null)] }, now).summary).toBe('1 running · oldest unknown unknown');
    expect(workerRows({ workers: [] }, now).summary).toBe('No workers running');
  });

  it('sets tones at the 20 and 45 minute boundaries', () => {
    const view = workerRows({ workers: [worker('a', 1199), worker('b', 1200), worker('c', 2700), worker('d', 2701), worker('e', null)] }, now);
    expect(Object.fromEntries(view.rows.map(row => [row.job, row.tone]))).toEqual({ a: 'ok', b: 'warn', c: 'warn', d: 'bad', e: 'unknown' });
  });
});
