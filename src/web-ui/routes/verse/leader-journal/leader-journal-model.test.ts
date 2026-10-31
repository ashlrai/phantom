import { describe, expect, it } from 'vitest';
import { groupRejects, ingestTone, isLeaderJournal, passSummary } from './leader-journal-model.js';

const valid = () => ({ v: 1, generatedAt: '2026-01-01', notes: [], sources: { orchestration: 'healthy', planLog: 'healthy', ingestLog: 'missing', ingested: 'degraded' },
  passes: [{ at: '2026-01-01', sections: [{ title: 'Plan', bullets: ['First'] }] }],
  ingest: [{ verb: 'reject', file: 'job.json', reason: null }],
  ingested: [{ at: '2026-01-01', id: 'job', leader: 'alpha', lane: 'main', tier: 'mid', title: 'Job' }], rejectedLastHour: 0 });

describe('leader journal model', () => {
  it('validates the complete wire shape and nested values', () => {
    expect(isLeaderJournal(valid())).toBe(true);
    expect(isLeaderJournal({ ...valid(), v: 2 })).toBe(false);
    expect(isLeaderJournal({ ...valid(), sources: { ...valid().sources, planLog: 'unknown' } })).toBe(false);
    expect(isLeaderJournal({ ...valid(), passes: [{ at: 'now', sections: [{ title: 'Plan', bullets: [3] }] }] })).toBe(false);
    expect(isLeaderJournal({ ...valid(), ingest: [{ verb: 'reject', file: 'job', reason: 1 }] })).toBe(false);
    expect(isLeaderJournal({ ...valid(), ingested: [{ id: 'job' }] })).toBe(false);
    expect(isLeaderJournal({ ...valid(), rejectedLastHour: -1 })).toBe(false);
    expect(isLeaderJournal(null)).toBe(false);
  });
  it('summarizes the first bullet, trims and limits it to 120 characters', () => {
    expect(passSummary({ at: '', sections: [{ title: '', bullets: [`  ${'a'.repeat(130)}  `, 'second'] }] })).toBe('a'.repeat(120));
    expect(passSummary({ at: '', sections: [] })).toBe('');
    expect(passSummary({ at: '', sections: [{ title: '', bullets: [] }, { title: '', bullets: ['later'] }] })).toBe('');
  });
  it('counts only rejected rows by verbatim reason, including unusual keys', () => {
    const rows = [{ verb: 'reject', file: 'a', reason: 'denied-path' }, { verb: 'rejected', file: 'b', reason: 'denied-path' },
      { verb: 'reject', file: 'c', reason: '__proto__' }, { verb: 'reject', file: 'd', reason: null }, { verb: 'accept', file: 'e', reason: 'denied-path' }];
    expect(ingestTone(rows[0]!)).toBe('bad');
    expect(ingestTone(rows[4]!)).toBe('neutral');
    expect({ ...groupRejects(rows) }).toEqual({ 'denied-path': 2, ['__proto__']: 1, 'unknown reason': 1 });
  });
});
