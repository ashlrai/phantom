import { expect, it } from 'vitest';
import { holdSteerPrefill, repeatSteerPrefill } from './decision-steer-prefill.js';

it('formats a repeated skip as an order', () => {
  expect(repeatSteerPrefill({ itemId: 'fake', title: 'Example', runs: 4, since: 'yesterday', reason: 'No seat' }))
    .toBe("Bet 'Example' has been skipped 4 ticks in a row since yesterday: No seat. Drop it or unblock it.");
});

it('formats a hold, including an unknown eligibility time', () => {
  const row = { key: 'fake', repo: 'example/repo', title: 'Example', holdKind: 'drip', reason: 'Waiting', nextEligibleAt: null };
  expect(holdSteerPrefill(row)).toBe("Bet 'Example' (example/repo) is held (drip): Waiting. Next eligible unknown. Keep the hold or release it.");
  expect(holdSteerPrefill({ ...row, nextEligibleAt: 'tomorrow' })).toContain('Next eligible tomorrow.');
});

it('caps titles at 120 characters and keeps both orders under 500 characters', () => {
  const long = 'x'.repeat(1000);
  const repeat = repeatSteerPrefill({ itemId: 'fake', title: long, runs: 4, since: long, reason: long });
  const hold = holdSteerPrefill({ key: 'fake', title: long, repo: long, holdKind: long, reason: long, nextEligibleAt: long });
  for (const text of [repeat, hold]) {
    expect(text.length).toBeLessThan(500);
    expect(text).toContain(`Bet '${'x'.repeat(120)}'`);
  }
  expect(repeat.endsWith('Drop it or unblock it.')).toBe(true);
  expect(hold.endsWith('Keep the hold or release it.')).toBe(true);
});
