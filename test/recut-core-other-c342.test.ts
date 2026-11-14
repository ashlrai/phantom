import { describe, expect, it } from 'vitest';
import { changelogSection } from '../src/core/verse/changelog-read.js';

describe('recut core changelog preservation c342', () => {
  it('renders both emphasis styles as plain text through the public parser', () => {
    const markdown = [
      '## [1.2.3] - 2026-11-14',
      '* **verse:** show [release notes](https://example.com/notes) (#42)',
      '* __core:__ preserve unknown usage',
      '## [1.2.2] - 2026-11-13',
      '* older entry',
    ].join('\n');

    expect(changelogSection(markdown, '1.2.3')).toEqual([
      'verse: show release notes',
      'core: preserve unknown usage',
    ]);
    expect(changelogSection(markdown, '1.2.2')).toEqual(['older entry']);
    expect(changelogSection(markdown, '1.2.4')).toBeNull();
  });
});
