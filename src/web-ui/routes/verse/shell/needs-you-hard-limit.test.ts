import { describe, expect, it } from 'vitest';
import { hardLimitLabel, splitByHardLimit } from './needs-you-hard-limit.js';

describe('hardLimitLabel', () => {
  it.each([
    ['rotate the deploy token', 'secrets', 'Only you: secrets'],
    ['approve the billing plan change', 'money', 'Only you: money'],
    ['send the launch note to the customer', 'outside-send', 'Only you: outside send'],
    ['delete the staging database', 'destroy-data', 'Only you: deletes data'],
  ])('%s → %s', (text, limit, label) => {
    expect(hardLimitLabel(text)).toEqual({ kind: 'only-you', limit, label });
  });

  it('keeps release signing for Mason', () => {
    expect(hardLimitLabel('notarize the desktop build')).toMatchObject({ kind: 'only-you', limit: 'authority' });
  });

  it('word boundaries: a "tokenizer" text is Phantom-clearable', () => {
    expect(hardLimitLabel('fix the tokenizer bench')).toEqual({ kind: 'phantom', label: 'Phantom can clear' });
    expect(hardLimitLabel('rerun flaky test')).toEqual({ kind: 'phantom', label: 'Phantom can clear' });
  });
});

describe('splitByHardLimit', () => {
  it('keeps input order in each half and counts them', () => {
    const items = [
      { id: 'a', title: 'rerun flaky test' },
      { id: 'b', title: 'rotate the deploy token' },
      { id: 'c', title: 'tidy the drawer' },
      { id: 'd', title: 'delete the old bucket' },
    ];
    const split = splitByHardLimit(items);
    expect(split.onlyYou.map((i) => i.id)).toEqual(['b', 'd']);
    expect(split.phantom.map((i) => i.id)).toEqual(['a', 'c']);
    expect(split.counts).toEqual({ onlyYou: 2, phantom: 2 });
  });
});
