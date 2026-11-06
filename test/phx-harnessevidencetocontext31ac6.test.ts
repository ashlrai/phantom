import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildNodeContextPack } from '../src/core/fleet/node-context-pack.js';
import { readHarnessDigest } from '../src/core/learn/harness-digest-reader.js';

describe('harness evidence to worker context', () => {
  it('retrieves the relevant learning with its citation and license within the byte budget', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-context-'));
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      const file = join(dir, 'digest.md');
      writeFileSync(file, `# Harness learning

## S1 — Trace study
- Checked: 2026-10-31.
- Source: [Study](https://example.invalid/study)
- License: MIT
- License source: [License](https://example.invalid/mit)
- Takeaway: Compare café traces before rollout.

## S2 — Queue study
- Checked: 2026-10-30.
- Source: [Study](https://example.invalid/queue)
- License: Apache-2.0
- License source: [License](https://example.invalid/apache)
- Takeaway: Batch messages to reduce overhead.
`);
      const digest = readHarnessDigest(file, new Date('2026-10-31T00:36:00Z'));
      expect(digest).not.toBeNull();
      expect(digest!.issues).toEqual([]);
      expect(digest!.sources).toHaveLength(2);
      expect(digest!.sources[0]).toMatchObject({
        id: 'S1', checkedAt: '2026-10-31', urls: ['https://example.invalid/study'],
        license: 'MIT', licenseUrls: ['https://example.invalid/mit'],
        takeaways: ['Compare café traces before rollout.'],
      });
      expect(digest!.sources[1]).toMatchObject({
        id: 'S2', checkedAt: '2026-10-30', urls: ['https://example.invalid/queue'],
        license: 'Apache-2.0', licenseUrls: ['https://example.invalid/apache'],
        takeaways: ['Batch messages to reduce overhead.'],
      });

      // The caller carries parsed evidence into records; the builder does not read digests.
      const tasks = digest!.sources.map(source => ({ jobId: source.id, text: source.title }));
      const outputs = digest!.sources.map(source => ({
        jobId: source.id,
        text: [
          ...source.takeaways ?? [],
          `Checked: ${source.checkedAt}`,
          `Citations: ${source.urls.join(', ')}`,
          `License: ${source.license}`,
          `License source: ${source.licenseUrls?.join(', ')}`,
        ].join('\n'),
      }));
      const input = {
        node: { jobId: 'worker', upstreamJobIds: [], query: 'café traces' },
        tasks,
        outputs,
        byteBudget: 4096,
      };
      const pack = buildNodeContextPack(input);
      const rows = pack.trimEnd().split('\n').map(line => JSON.parse(line));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ jobId: 'S1', kind: 'output', truncated: false });
      expect(rows[0].text).toContain('Compare café traces before rollout.');
      expect(rows[0].text).toContain('2026-10-31');
      expect(rows[0].text).toContain('https://example.invalid/study');
      expect(rows[0].text).toContain('MIT');
      expect(rows[0].text).toContain('https://example.invalid/mit');
      expect(pack).not.toContain('S2');
      expect(pack).not.toContain('Batch messages');

      const exactBytes = Buffer.byteLength(pack, 'utf8');
      expect(buildNodeContextPack({ ...input, byteBudget: exactBytes })).toBe(pack);
      const tightPack = buildNodeContextPack({ ...input, byteBudget: exactBytes - 1 });
      expect(Buffer.byteLength(tightPack, 'utf8')).toBeLessThanOrEqual(exactBytes - 1);
      expect(JSON.parse(tightPack)).toMatchObject({ jobId: 'S1', kind: 'output', truncated: true });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
