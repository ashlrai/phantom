import { describe, expect, it } from 'vitest';
import { unshippedText } from './release-gap-model.js';

describe('unshipped release gap', () => {
  it.each([null, 0])('omits a missing or zero count (%s)', commitsSinceTag => {
    expect(unshippedText({ commitsSinceTag, prNumber: 1479, prBlocked: true })).toBeNull();
  });

  it('shows a count without PR details', () => {
    expect(unshippedText({ commitsSinceTag: 877, prNumber: null, prBlocked: null }))
      .toBe('877 commits merged since, not yet released');
    expect(unshippedText({ commitsSinceTag: 877, prNumber: 1479, prBlocked: null }))
      .toBe('877 commits merged since, not yet released');
  });

  it.each([[false, 'open'], [true, 'blocked']] as const)('shows an open PR with blocked=%s', (prBlocked, status) => {
    expect(unshippedText({ commitsSinceTag: 877, prNumber: 1479, prBlocked }))
      .toBe(`877 commits merged since, not yet released · release PR #1479 ${status}`);
  });
});
