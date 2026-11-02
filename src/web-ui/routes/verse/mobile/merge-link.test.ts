import { describe, expect, it } from 'vitest';
import { mergeLabel, prUrl } from './merge-link.js';

const merge = { repo: 'ashlrai/phantom', number: 1811, title: 'RQ-PHX-WORKERCHANGES31' };
describe('merge links', () => {
  it('builds a GitHub PR link and label', () => {
    expect(prUrl(merge)).toBe('https://github.com/ashlrai/phantom/pull/1811');
    expect(mergeLabel(merge)).toBe('#1811 · RQ-PHX-WORKERCHANGES31');
  });
  it.each([{ repo: 'bad/repo/path' }, { repo: '../evil' }, { repo: 'ashlrai/phantom\n' }, { number: 0 }, { number: -1 },
    { number: Number.MAX_SAFE_INTEGER + 1 }, { number: 1.5 }])('rejects invalid input %o', (change) => {
    expect(prUrl({ ...merge, ...change })).toBeNull();
  });
});
