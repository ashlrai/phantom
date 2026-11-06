import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cmdReflect } from '../src/cli/reflect.js';
import { parseHarnessDigest } from '../src/core/learn/harness-digest-reader.js';

const now = new Date('2026-10-31T00:36:00Z');

function realSource(id: string, date: string): string {
  return `## ${id} — Real ${id}\n- Checked: ${date}.\n- Source: [real](https://example.test/${id})`;
}

describe('harness digest fenced examples', () => {
  it('ignores fake sections and fields while retaining real sections and notes', () => {
    const markdown = [
      realSource('S1', '2026-10-23'),
      '- Takeaway: First observation',
      '  continued before the example',
      '  ```markdown',
      '## S1 — Fake duplicate',
      '- Checked: 2026-10-31.',
      '- Source: [fake](https://example.test/fake)',
      '- Takeaway: Fake note',
      '  hidden continuation',
      '  ```',
      '- Takeaway: Another observation',
      '\tcontinued afterwards',
      realSource('S2', '2026-10-31'),
      '~~~',
      '## Sx — Fake malformed',
      '- Source: [fake](https://example.test/another)',
      '~~~',
    ].join('\r\n');
    expect(parseHarnessDigest(markdown, now)).toEqual({
      v: 1,
      sources: [
        { id: 'S1', title: 'Real S1', checkedAt: '2026-10-23', urls: ['https://example.test/S1'], stale: true,
          takeaways: ['First observation\ncontinued before the example', 'Another observation\ncontinued afterwards'] },
        { id: 'S2', title: 'Real S2', checkedAt: '2026-10-31', urls: ['https://example.test/S2'], stale: false },
      ],
      issues: [],
    });
  });

  it('does not let fenced fields replace the real date or supply a missing citation', () => {
    const markdown = [
      '## S1 — Real',
      '```',
      '- Checked: 2026-10-31.',
      '- Source: [fake](https://example.test/fake)',
      '- Takeaway: Fake note',
      '```',
      '- Checked: 2026-10-20.',
      '- Source: [real](https://example.test/real)',
      '## S2 — Uncited',
      '~~~example',
      '- Checked: 2026-10-31.',
      '- Source: [fake](https://example.test/fake)',
      '~~~',
    ].join('\n');
    const digest = parseHarnessDigest(markdown, now);
    expect(digest.sources).toEqual([
      { id: 'S1', title: 'Real', checkedAt: '2026-10-20', urls: ['https://example.test/real'], stale: true },
      { id: 'S2', title: 'Uncited', checkedAt: null, urls: [], stale: null },
    ]);
    expect(digest.issues).toEqual([{ id: 'S2', code: 'missing_checked' }, { id: 'S2', code: 'missing_urls' }]);
  });

  it('requires a matching fence character, minimum length, and a clean closing line', () => {
    const markdown = [
      realSource('S1', '2026-10-31'),
      '````markdown',
      '```',
      '~~~~~',
      '```` still an example',
      realSource('S9', '2026-10-31'),
      '`````',
      realSource('S2', '2026-10-31'),
      '~~~~',
      '~~~',
      '`````',
      realSource('S8', '2026-10-31'),
      '~~~~~',
      realSource('S3', '2026-10-31'),
    ].join('\n');
    const digest = parseHarnessDigest(markdown, now);
    expect(digest.sources.map(({ id }) => id)).toEqual(['S1', 'S2', 'S3']);
    expect(digest.sources.map(({ urls }) => urls)).toEqual([
      ['https://example.test/S1'], ['https://example.test/S2'], ['https://example.test/S3'],
    ]);
    expect(digest.issues).toEqual([]);
  });

  it('ignores the remainder after an unclosed fence and preserves indented takeaway text', () => {
    const markdown = [
      realSource('S1', '2026-10-31'),
      '- Takeaway: Before',
      '    four-space continuation',
      '\tmore continuation',
      '  ~~~ example',
      '  not a continuation',
      realSource('S9', '2026-10-31'),
    ].join('\n');
    const digest = parseHarnessDigest(markdown, now);
    expect(digest.sources).toEqual([{
      id: 'S1', title: 'Real S1', checkedAt: '2026-10-31', urls: ['https://example.test/S1'], stale: false,
      takeaways: ['Before\nfour-space continuation\nmore continuation'],
    }]);
    expect(digest.issues).toEqual([]);
  });

  it('keeps fenced examples out of the refresh projection without fetching citations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'digest-fences-'));
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      const path = join(dir, 'digest.md');
      writeFileSync(path, [realSource('S1', '2026-10-23'), '```', realSource('S9', '2026-10-01'), '```', realSource('S2', '2026-10-31')].join('\n'));
      expect(await cmdReflect(['harness-digest', '--file', path, '--json', '--needs-refresh'])).toBe(0);
      const digest = JSON.parse(String(stdout.mock.calls[0]![0]));
      expect(digest.sources.map((source: { id: string }) => source.id)).toEqual(['S1']);
      expect(digest.sources[0].urls).toEqual(['https://example.test/S1']);
      expect(digest.issues).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
