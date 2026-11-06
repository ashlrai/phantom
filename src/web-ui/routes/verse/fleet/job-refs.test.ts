import { describe, expect, it } from 'vitest';
import { pullUrl, splitRefs } from './job-refs.js';

describe('splitRefs', () => {
  it('finds complete job IDs and preserves punctuation and whitespace', () => {
    const text = '(RQ-PHX-FOO), LAND-123 and FIX-a.b!';
    expect(splitRefs(text)).toEqual([
      { kind: 'text', value: '(' }, { kind: 'job', value: 'RQ-PHX-FOO' },
      { kind: 'text', value: '), ' }, { kind: 'job', value: 'LAND-123' },
      { kind: 'text', value: ' and ' }, { kind: 'job', value: 'FIX-a.b' }, { kind: 'text', value: '!' },
    ]);
    expect(splitRefs('RQ-ABC.')).toEqual([{ kind: 'job', value: 'RQ-ABC' }, { kind: 'text', value: '.' }]);
    expect(splitRefs(`xRQ-ABC ${'RQ-' + 'a'.repeat(78)}`)).toEqual([{ kind: 'text', value: `xRQ-ABC ${'RQ-' + 'a'.repeat(78)}` }]);
    expect(splitRefs('OTHER-1 RQ-1', { prefixes: ['OTHER-'] })).toEqual([{ kind: 'job', value: 'OTHER-1' }, { kind: 'text', value: ' RQ-1' }]);
  });

  it('uses the preceding repo and defaults separately on each line', () => {
    expect(splitRefs('merged ashlrai/phantom #1719 bridge #1720\n#4')).toEqual([
      { kind: 'text', value: 'merged ashlrai/phantom ' }, { kind: 'pr', value: '#1719', repo: 'ashlrai/phantom', number: 1719 },
      { kind: 'text', value: ' bridge ' }, { kind: 'pr', value: '#1720', repo: 'ashlrai/phantom', number: 1720 },
      { kind: 'text', value: '\n' }, { kind: 'pr', value: '#4', repo: 'ashlrai/phantom', number: 4 },
    ]);
    expect(splitRefs('#2', { defaultRepo: 'other/project' })).toEqual([{ kind: 'pr', value: '#2', repo: 'other/project', number: 2 }]);
    expect(splitRefs('other/project #2\n#3', { defaultRepo: 'default/repo' })[3]).toEqual({ kind: 'pr', value: '#3', repo: 'default/repo', number: 3 });
  });

  it('rejects invalid repos and PR numbers without falling back to a different repo', () => {
    for (const text of ['../repo #1', 'owner/.. #2', 'owner/repo/extra #3', '#0', '#1.5', '#9007199254740992']) {
      expect(splitRefs(text)).toEqual([{ kind: 'text', value: text }]);
    }
    expect(splitRefs('#1', { defaultRepo: '../repo' })).toEqual([{ kind: 'text', value: '#1' }]);
    expect(pullUrl('owner/repo', 1.5)).toBeNull();
    expect(pullUrl('owner/repo', 0)).toBeNull();
  });

  it('handles empty text', () => { expect(splitRefs('')).toEqual([]); });
});
