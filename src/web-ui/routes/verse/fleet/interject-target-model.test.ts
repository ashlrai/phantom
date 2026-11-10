import { expect, it } from 'vitest';
import { insertMention, matchRunningJobs, mentionQuery, targetsOf } from './interject-target-model.js';

it('finds a mention at the caret, but not in a word', () => {
  expect(mentionQuery('aim @RQ-PH now', 10)).toBe('RQ-PH');
  expect(mentionQuery('email@RQ-PH', 11)).toBeNull();
  expect(mentionQuery('@', 1)).toBe('');
});
it('matches running jobs without case sensitivity and limits results', () => {
  const jobs = [{ job: 'RQ-PHX-ONE' }, { job: 'RQ-PHX-TWO' }];
  expect(matchRunningJobs('phx', jobs, 1)).toEqual([jobs[0]]);
  expect(matchRunningJobs('', [])).toEqual([]);
});
it('replaces the whole mention at the caret and returns the new caret', () => {
  expect(insertMention('aim @RQ-PHX-OLD now', 10, 'RQ-NEW')).toEqual({ text: 'aim @RQ-NEW  now', caret: 12 });
  expect(insertMention('plain', 5, 'RQ-NEW')).toEqual({ text: 'plain', caret: 5 });
});
it('returns unique mentioned targets', () => {
  expect(targetsOf('@RQ-ONE @RQ-ONE and @RQ-TWO')).toEqual(['RQ-ONE', 'RQ-TWO']);
});
