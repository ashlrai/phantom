import { expect, it } from 'vitest';
import { parseOwnerThreadRead } from './owner-thread-queries.js';

it('rejects an unrecognized reply-gap state from an untyped response', () => {
  const response: unknown = JSON.parse('{"status":{"replyGap":[{"teammate":"Dot","unansweredCount":1,"oldestUnansweredMs":100,"state":"weird"}]}}');
  expect(parseOwnerThreadRead(response).replyGap).toEqual([]);
});
