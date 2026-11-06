import { describe, expect, it } from 'vitest';
import { mentionedRefs } from './thread-refs.js';

describe('mentionedRefs', () => {
  it('returns distinct jobs then PRs in first-seen order within each kind', () => {
    expect(mentionedRefs('See acme/app#42, RQ-PHX-ONE and #7; RQ-PHX-TWO, RQ-PHX-ONE, acme/app#42 and #7.'))
      .toEqual(['RQ-PHX-ONE', 'RQ-PHX-TWO', 'acme/app#42', '#7']);
  });

  it('caps the combined result at eight, prioritizing jobs', () => {
    expect(mentionedRefs('#1 #2 RQ-A1 RQ-A2 RQ-A3 RQ-A4 RQ-A5 RQ-A6 RQ-A7 #3'))
      .toEqual(['RQ-A1', 'RQ-A2', 'RQ-A3', 'RQ-A4', 'RQ-A5', 'RQ-A6', 'RQ-A7', '#1']);
  });

  it('ignores plain text and invalid references', () => {
    expect(mentionedRefs('Nothing to see here.')).toEqual([]);
    expect(mentionedRefs('bad/path/extra#12 #0 #1.2 #123abc RQ-' + 'X'.repeat(90))).toEqual([]);
  });
});
