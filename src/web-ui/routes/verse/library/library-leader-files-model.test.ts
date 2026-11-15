import { describe, expect, it } from 'vitest';
import { leaderFileAge, leaderFileLabel, leaderFileRows, leaderFileSize, narrowLeaderFiles } from './library-leader-files-model.js';

const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const file = (name: string, modifiedAt: string, over: Record<string, unknown> = {}) => ({ name, size: 100, modifiedAt, preview: 'p', ...over });
const body = (files: unknown[], extra: Record<string, unknown> = {}) => ({ v: 1, observedAt: '2026-11-09T12:00:00.000Z', files, ...extra });

describe('narrowLeaderFiles', () => {
  it('accepts a well-formed body and the two empty states', () => {
    expect(narrowLeaderFiles(body([file('VISION.md', '2026-11-09T10:00:00.000Z')]))).not.toBeNull();
    expect(narrowLeaderFiles(body([], { state: 'absent' }))?.state).toBe('absent');
    expect(narrowLeaderFiles(body([], { state: 'unavailable' }))?.state).toBe('unavailable');
  });
  it.each([
    ['null', null],
    ['wrong version', { ...body([]), v: 2 }],
    ['bad observedAt', body([], { observedAt: 'nope' })],
    ['files not array', body([] as unknown[], { files: {} })],
    ['unknown state', body([], { state: 'weird' })],
    ['state with files', body([file('VISION.md', '2026-11-09T10:00:00.000Z')], { state: 'absent' })],
    ['absolute path', body([file('/etc/passwd', '2026-11-09T10:00:00.000Z')])],
    ['traversal path', body([file('drafts/../x.md', '2026-11-09T10:00:00.000Z')])],
    ['negative size', body([file('VISION.md', '2026-11-09T10:00:00.000Z', { size: -1 })])],
    ['bad time', body([file('VISION.md', 'yesterday')])],
    ['non-string preview', body([file('VISION.md', '2026-11-09T10:00:00.000Z', { preview: 5 })])],
    ['oversized preview', body([file('VISION.md', '2026-11-09T10:00:00.000Z', { preview: 'x'.repeat(241) })])],
    ['non-object row', body(['VISION.md'])],
  ])('rejects %s', (_n, x) => { expect(narrowLeaderFiles(x)).toBeNull(); });
});

describe('labels, age, size', () => {
  it('labels known files and drafts', () => {
    expect(leaderFileLabel('VISION.md')).toBe('Vision');
    expect(leaderFileLabel('PLAN-LOG.md')).toBe('Plan log');
    expect(leaderFileLabel('INSPIRATION.md')).toBe('Inspiration');
    expect(leaderFileLabel('drafts/launch-note.md')).toBe('Draft: launch-note');
  });
  it('formats relative age', () => {
    expect(leaderFileAge('2026-11-09T11:59:40.000Z', NOW)).toBe('just now');
    expect(leaderFileAge('2026-11-09T11:15:00.000Z', NOW)).toBe('45 min ago');
    expect(leaderFileAge('2026-11-09T10:00:00.000Z', NOW)).toBe('2 h ago');
    expect(leaderFileAge('2026-11-06T12:00:00.000Z', NOW)).toBe('3 d ago');
    expect(leaderFileAge('2026-11-10T12:00:00.000Z', NOW)).toBe('just now');
  });
  it('formats size', () => {
    expect(leaderFileSize(512)).toBe('512 B');
    expect(leaderFileSize(2048)).toBe('2.0 KB');
  });
});

describe('leaderFileRows', () => {
  it('sorts newest first and keeps server order on ties', () => {
    const rows = leaderFileRows([
      file('INSPIRATION.md', '2026-11-09T09:00:00.000Z') as never,
      file('drafts/b.md', '2026-11-09T11:00:00.000Z') as never,
      file('VISION.md', '2026-11-09T11:00:00.000Z') as never,
      file('PLAN-LOG.md', '2026-11-09T11:30:00.000Z') as never,
    ], NOW);
    expect(rows.map((r) => r.label)).toEqual(['Plan log', 'Draft: b', 'Vision', 'Inspiration']);
    expect(rows[0]).toMatchObject({ age: '30 min ago', size: '100 B', preview: 'p' });
  });
});
