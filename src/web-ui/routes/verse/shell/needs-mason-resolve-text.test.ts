import { expect, it } from 'vitest';
import { needsMasonResolvedText } from './needs-mason-resolve-text.js';

it.each([
  [{ inbox: 'appended' }, 'Resolved. Your reply went to the planner inbox.'],
  [{ inbox: 'failed' }, 'Resolved, but your reply did not reach the planner inbox. Use Tell the leaders to resend it.'],
  [{ inbox: 'skipped' }, 'Resolved.'],
  [{}, 'Resolved.'],
  [null, 'Resolved.'],
  ['fake server error', 'Resolved.'],
  [{ inbox: 'unknown' }, 'Resolved.'],
])('describes inbox result %j safely', (response, expected) => {
  expect(needsMasonResolvedText('Pick a fake color', response)).toBe(expected);
});
