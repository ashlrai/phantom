import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { REVIEW_PICK_PATH, parseReviewPickBody, type ReviewPickParse } from './review-pick-model.js';

/**
 * One read of the review-pick route. 404, a network error or a malformed
 * body all resolve to `unavailable` — the strip renders nothing, never a
 * guessed pick.
 */
export const reviewPickQuery: QueryDef<ReviewPickParse> = {
  key: 'verse-fleet-work-board-review-pick',
  async fetch(signal) {
    try {
      return parseReviewPickBody(await apiGet<unknown>(REVIEW_PICK_PATH, signal));
    }
    catch (error) {
      if (signal?.aborted) throw error;
      return { kind: 'unavailable' };
    }
  },
};
