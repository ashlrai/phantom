/** RQ-PHX-SLACKREVIEWASK374 — isReviewAsk: the exact, short owner "review"
 * ask set answered in-thread by review-pick-reply.ts. Anything longer, or any
 * other phrasing such as "review PR #12 please", stays a request for the
 * Leader. */
import { describe, expect, it } from 'vitest';
import { isReviewAsk } from '../src/core/fleet/review-ask.js';

describe('isReviewAsk', () => {
  it.each([
    'review', 'Review', 'REVIEW', '  review  ', 'review?', 'Review?!', 'review.',
    'review pick', 'Review Pick', 'REVIEW PICK?', '  review pick  ',
    'unowned review', 'Unowned Review', 'UNOWNED REVIEW?', 'unowned review!',
  ])('accepts %j', ask => { expect(isReviewAsk(ask)).toBe(true); });

  it.each([
    'review PR #12 please', 'review pr #12', 'review please', 'please review',
    'reviews', 'review queue', 'my review', 'the review', 'review status',
    'pick review', 'review pick please', 'unowned review please', 'unowned reviews',
    'status', 'recheck', 'orders', '', '   ',
  ])('rejects %j', ask => { expect(isReviewAsk(ask)).toBe(false); });

  it('rejects a 41-char string even when it otherwise reads as a review ask', () => {
    const long = `review${' '.repeat(34)}x`;
    expect(long).toHaveLength(41);
    expect(isReviewAsk(long)).toBe(false);
    const padded = `unowned review${'?'.repeat(27)}`;
    expect(padded).toHaveLength(41);
    expect(isReviewAsk(padded)).toBe(false);
    const boundary = `unowned review${'?'.repeat(26)}`;
    expect(boundary).toHaveLength(40);
    expect(isReviewAsk(boundary)).toBe(true);
  });

  it('rejects non-string input', () => {
    expect(isReviewAsk(undefined as unknown as string)).toBe(false);
    expect(isReviewAsk(null as unknown as string)).toBe(false);
  });

  it('folds a curly apostrophe the same way status-ask does — without opening a new ask', () => {
    expect(isReviewAsk('review’')).toBe(false);
    expect(isReviewAsk('mason’s review')).toBe(false);
  });
});
