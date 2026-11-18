import { expect, it } from 'vitest';
import { supersededOpenPrs } from '../src/core/fleet/merge-plan-rework.js';

it('proposes the older open PR when a rework explicitly supersedes it', () => {
  const result = supersededOpenPrs([
    { number: 10, title: 'Original', body: '', isDraft: false },
    { number: 11, title: 'Rework', body: 'Supersedes #10', isDraft: false },
    { number: 12, title: 'Unrelated', body: 'Compared #10', isDraft: false },
  ], 'ashlrai/phantom');
  expect(result.proposals).toMatchObject([{ number: 10, supersededBy: 11, evidence: ['body-supersedes'] }]);
});

it('does not propose closing a PR in favor of a draft', () => {
  const result = supersededOpenPrs([
    { number: 10, title: 'Original', body: 'superseded by #11', isDraft: false },
    { number: 11, title: 'Draft', body: '', isDraft: true },
  ], 'ashlrai/phantom');
  expect(result.proposals).toEqual([]);
});
