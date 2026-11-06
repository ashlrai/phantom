import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cmdReflect } from '../src/cli/reflect.js';
import { parseHarnessDigest, readHarnessDigest } from '../src/core/learn/harness-digest-reader.js';

const now = new Date('2026-10-31T12:00:00Z');
const fields = '- Checked: 2026-10-31.\n- Source: [citation](https://example.test/citation)';

describe('harness digest license evidence', () => {
  it('reads explicit evidence and takeaways from a real file, scoped to each source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'digest-license-'));
    try {
      const path = join(dir, 'digest.md');
      writeFileSync(path, [
        '- License: Outside section',
        '## S1 — First', fields,
        '- License: MIT',
        '- License source: [license](https://example.test/mit) [duplicate](https://example.test/mit)',
        '- License source: https://example.test/another',
        '- Takeaway: Learn the pattern', '  Preserve this continuation',
        '```markdown',
        '- License: Fake', '- License source: [fake](https://example.test/fake)',
        '## S9 — Fake source', '```',
        '## S2 — Second', fields,
        '- License: unknown', '- Takeaway: Independently review', '\tcontinued',
        '## S3 — Third', fields,
        '## Other section', '- License: Wrong section', '- License source: [wrong](https://example.test/wrong)',
      ].join('\n'));
      expect(readHarnessDigest(path, now)).toEqual({
        v: 1,
        sources: [
          { id: 'S1', title: 'First', checkedAt: '2026-10-31', urls: ['https://example.test/citation'], stale: false,
            license: 'MIT', licenseUrls: ['https://example.test/mit', 'https://example.test/another'],
            takeaways: ['Learn the pattern\nPreserve this continuation'] },
          { id: 'S2', title: 'Second', checkedAt: '2026-10-31', urls: ['https://example.test/citation'], stale: false,
            license: 'unknown', takeaways: ['Independently review\ncontinued'] },
          { id: 'S3', title: 'Third', checkedAt: '2026-10-31', urls: ['https://example.test/citation'], stale: false },
        ],
        issues: [],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps missing and blank licenses absent without inferring them from citations', () => {
    const digest = parseHarnessDigest(`## S1 — Missing\n${fields}\n- License:   \n- License source: \n## S2 — Also missing\n${fields}`, now);
    for (const source of digest.sources) {
      expect(source).not.toHaveProperty('license');
      expect(source).not.toHaveProperty('licenseUrls');
    }
  });

  it('retains the first nonblank short label and rejects overlong labels', () => {
    const digest = parseHarnessDigest([
      '## S1 — Bounded', fields, `- License: ${'x'.repeat(121)}`, '- License:  ', `- License: ${'é'.repeat(120)}  `, '- License: Later',
      '## S2 — Too long', fields, `- License: ${'x'.repeat(121)}`,
    ].join('\n'), now);
    expect(digest.sources[0]!.license).toBe('é'.repeat(120));
    expect(digest.sources[1]).not.toHaveProperty('license');
  });

  it('only retains valid HTTPS license links without userinfo and deduplicates across fields', () => {
    const digest = parseHarnessDigest([
      '## S1 — Links', fields,
      '- License source: [ok](https://example.test/license) [duplicate](https://example.test/license)',
      '- License source: [http](http://example.test/license) [bad](https://) [user](https://fake@example.test/license)',
      '- License source: [password](https://fake:fake@example.test/license) [empty](https://@example.test/license)',
      '- License source: [relative](https:example.test) [ftp](ftp://example.test/license)',
      '- License source: [another](https://example.test/second) [again](https://example.test/license)',
      '## S2 — Invalid only', fields, '- License source: [bad](https://fake@example.test/license)',
    ].join('\n'), now);
    expect(digest.sources[0]!.licenseUrls).toEqual(['https://example.test/license', 'https://example.test/second']);
    expect(digest.sources[0]!.urls).toEqual(['https://example.test/citation']);
    expect(digest.sources[1]).not.toHaveProperty('licenseUrls');
  });

  it('does not treat license links as citations or change missing citation issues', () => {
    const digest = parseHarnessDigest('## S1 — Uncited\n- Checked: 2026-10-31.\n- License: MIT\n- License source: [license](https://example.test/license)', now);
    expect(digest.sources[0]!.urls).toEqual([]);
    expect(digest.sources[0]!.licenseUrls).toEqual(['https://example.test/license']);
    expect(digest.issues).toEqual([{ id: 'S1', code: 'missing_urls' }]);
  });

  it('exposes evidence in CLI JSON without fetching it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'digest-license-cli-'));
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      const path = join(dir, 'digest.md');
      writeFileSync(path, `## S1 — Example\n${fields}\n- License: MIT\n- License source: [license](https://example.test/license)\n`);
      expect(await cmdReflect(['harness-digest', '--file', path, '--json'])).toBe(0);
      const source = JSON.parse(String(stdout.mock.calls[0]![0])).sources[0];
      expect(source.license).toBe('MIT');
      expect(source.licenseUrls).toEqual(['https://example.test/license']);
      expect(source.urls).toEqual(['https://example.test/citation']);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
