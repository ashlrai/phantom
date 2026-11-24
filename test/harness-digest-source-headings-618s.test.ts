import { describe, expect, it } from 'vitest';
import { parseHarnessDigest } from '../src/core/learn/harness-digest-reader.js';

// Fixed clock: 2026-11-16 is two days old (fresh), 2026-11-17 is one day old.
const NOW = new Date('2026-11-18T00:00:00Z');

describe('harness digest source heading recognition', () => {
  it('keeps the valid source and ignores ordinary S-prefixed prose sections', () => {
    const digest = parseHarnessDigest([
      '## S1 — Real source',
      '- Checked: 2026-11-16.',
      '- Source: [x](https://example.test/1)',
      '- Takeaway: keep this',
      '## Signals',
      '- trend text',
      '- Takeaway: must not attach to S1',
      '## Summary',
      'prose',
      '## Selected',
      '- Takeaway: also not attached',
      '## S2',
      '- Checked: 2026-11-16.',
      '- Source: [y](https://example.test/2)',
      '## Sx — Bad id',
      '## S3 —',
    ].join('\n'), NOW);

    expect(digest.sources).toEqual([{
      id: 'S1',
      title: 'Real source',
      checkedAt: '2026-11-16',
      urls: ['https://example.test/1'],
      stale: false,
      takeaways: ['keep this'],
    }]);
    expect(digest.issues).toEqual([
      { id: 'S2', code: 'malformed_id' },
      { id: 'Sx', code: 'malformed_id' },
      { id: 'S3', code: 'malformed_id' },
    ]);
  });

  it('flags glued or separator-less S-tokens as malformed rather than dropping them', () => {
    const digest = parseHarnessDigest('## S4—Glued\n## S5\n## S6 —\n', NOW);
    expect(digest.sources).toEqual([]);
    expect(digest.issues).toEqual([
      { id: 'S4—Glued', code: 'malformed_id' },
      { id: 'S5', code: 'malformed_id' },
      { id: 'S6', code: 'malformed_id' },
    ]);
  });

  it('does not treat headings inside a code fence as sources or section boundaries', () => {
    const digest = parseHarnessDigest([
      '## S1 — Fenced',
      '- Checked: 2026-11-16.',
      '- Source: [x](https://example.test/1)',
      '- Takeaway: before fence',
      '```md',
      '## S9 — Inside fence',
      '- Takeaway: fenced takeaway',
      '## S2',
      '## Signals',
      '```',
      '- Takeaway: after fence',
    ].join('\n'), NOW);

    expect(digest.sources.map(source => source.id)).toEqual(['S1']);
    expect(digest.sources[0]!.takeaways).toEqual(['before fence', 'after fence']);
    expect(digest.issues).toEqual([]);
  });

  it('keeps takeaways bounded to their own adjacent source', () => {
    const digest = parseHarnessDigest([
      '## S1 — One',
      '- Checked: 2026-11-16.',
      '- Source: [a](https://example.test/a)',
      '- Takeaway: one takeaway',
      '  continued line',
      '## S2 — Two',
      '- Checked: 2026-11-17.',
      '- Source: [b](https://example.test/b)',
      '  - Takeaway: not a takeaway',
      '- Takeaway: two takeaway',
      '## Summary',
      '  indented prose after Summary',
    ].join('\n'), NOW);

    expect(digest.issues).toEqual([]);
    expect(digest.sources.map(source => [source.id, source.checkedAt, source.takeaways])).toEqual([
      ['S1', '2026-11-16', ['one takeaway\ncontinued line']],
      ['S2', '2026-11-17', ['two takeaway']],
    ]);
  });

  it('still reports an empty title on a real source as malformed and drops its fields', () => {
    const digest = parseHarnessDigest([
      '## S1 — ',
      '- Checked: 2026-11-16.',
      '- Source: [x](https://example.test/1)',
    ].join('\n'), NOW);
    expect(digest.sources).toEqual([]);
    expect(digest.issues).toEqual([{ id: 'S1', code: 'malformed_id' }]);
  });
});
