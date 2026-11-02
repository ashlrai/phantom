import { describe, expect, it } from 'vitest';
import { releaseVerdictLine } from './release-verdict-model.js';

describe('releaseVerdictLine', () => {
  const line = 'Would ship 3.29.16, tree targets 3.30.0 · blocked';

  it('blocks a reported downgrade', () => {
    expect(releaseVerdictLine({ treeVersion: '3.30.0', versionVerdict: 'downgrade' }, '3.29.16'))
      .toEqual({ verdict: 'downgrade', blocked: true, line });
  });

  it('compares versions when the verdict is absent', () => {
    expect(releaseVerdictLine({ treeVersion: '3.30.0' }, '3.29.16'))
      .toEqual({ verdict: 'downgrade', blocked: true, line });
    expect(releaseVerdictLine({ treeVersion: '3.30.0' }, '3.30.0'))
      .toEqual({ verdict: 'match', blocked: false, line: null });
    expect(releaseVerdictLine({ treeVersion: '3.30.0' }, '3.30.1'))
      .toEqual({ verdict: 'ahead', blocked: false, line: null });
    expect(releaseVerdictLine({ treeVersion: '3.9.0' }, '3.10.0').verdict).toBe('ahead');
  });

  it.each(['match', 'ahead', 'unknown'] as const)('does not block a reported %s', versionVerdict => {
    expect(releaseVerdictLine({ treeVersion: '3.30.0', versionVerdict }, '3.29.16'))
      .toEqual({ verdict: versionVerdict, blocked: false, line: null });
  });

  it.each([
    [null, '3.29.16'],
    [{ treeVersion: '3.30.0-beta', versionVerdict: 'downgrade' }, '3.29.16'],
    [{ treeVersion: '3.30.0', versionVerdict: 'bad' }, '3.29.16'],
    [{ treeVersion: '3.30.0', versionVerdict: null }, '3.29.16'],
    [{ treeVersion: '3.30.0' }, '3.29.16.1'],
    [{ treeVersion: '10000.0.0' }, '3.29.16'],
    [{}, '3.29.16'],
  ])('treats malformed or missing fields as unknown', (entry, version) => {
    expect(releaseVerdictLine(entry, version)).toEqual({ verdict: 'unknown', blocked: false, line: null });
  });
});
