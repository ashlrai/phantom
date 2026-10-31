import { describe, expect, it } from 'vitest';
import { filterPasses, passFilterLabel } from './leader-journal-model.js';

const passes = [
  { at: '1', sections: [{ title: 'Release plan', bullets: ['Ship the PR', 'Wait 5h'] }] },
  { at: '2', sections: [{ title: 'Review', bullets: ['Release approved'] }] },
];

describe('journal search', () => {
  it('matches titles and bullets case-insensitively and records matching bullets', () => {
    const results = filterPasses(passes, 'RELEASE');
    expect(results.map(({ pass }) => pass.at)).toEqual(['1', '2']);
    expect(results[0]!.matchedBullets.size).toBe(0);
    expect([...results[1]!.matchedBullets]).toEqual(['Release approved']);
    expect(filterPasses(passes, '5H')[0]!.matchedBullets.has('Wait 5h')).toBe(true);
    expect(filterPasses(passes, 'missing')).toEqual([]);
  });
  it('returns all passes without highlights for an empty query and formats counts', () => {
    expect(filterPasses(passes, ' ').map(({ pass, matchedBullets }) => [pass.at, matchedBullets.size])).toEqual([['1', 0], ['2', 0]]);
    expect(passFilterLabel(3, 18)).toBe('3 of 18 passes');
    expect(passFilterLabel(18, 18)).toBe('');
  });
});
