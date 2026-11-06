import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readHarnessDigest } from '../src/core/learn/harness-digest-reader.js';

const now = new Date('2026-10-31T00:36:00Z');

// Existing citation-only entries and newer notes share the same real digest syntax.
const markdown = `# Harness learning

## S1 — Earlier fresh citation
- Checked: 2026-10-24.
- Source: [Alpha](https://example.invalid/alpha) and [Beta](https://example.invalid/beta).
- Evidence: A fictional team captured traces.

## S2 — Earlier stale citation
- Checked: 2026-10-23.
- Source: [Old](https://example.invalid/old)

## S3 — New stale learning
- Checked: 2026-10-20.
- Source: [Study](https://example.invalid/study)
- Takeaway: Review café traces 🐈 before rollout.
  Preserve the naïve baseline.
  \`\`\`markdown
## S99 — Quoted example
- Checked: 2026-10-01.
- Source: [Quoted](https://example.invalid/quoted)
- Takeaway: This is an example, not a learning.
  \`\`\`
- Takeaway: Compare Δ outcomes.

## S4 — New fresh learning
- Checked: 2026-10-31.
- Source: [Fresh](https://example.invalid/fresh)
- Takeaway: Keep the résumé of the run.
~~~markdown
## S98 — Another quoted example
- Checked: 2026-10-01.
- Source: [Quoted](https://example.invalid/other-quoted)
~~~
`;

const sources = [
  { id: 'S1', title: 'Earlier fresh citation', checkedAt: '2026-10-24', urls: ['https://example.invalid/alpha', 'https://example.invalid/beta'], stale: false },
  { id: 'S2', title: 'Earlier stale citation', checkedAt: '2026-10-23', urls: ['https://example.invalid/old'], stale: true },
  { id: 'S3', title: 'New stale learning', checkedAt: '2026-10-20', urls: ['https://example.invalid/study'], stale: true,
    takeaways: ['Review café traces 🐈 before rollout.\nPreserve the naïve baseline.', 'Compare Δ outcomes.'] },
  { id: 'S4', title: 'New fresh learning', checkedAt: '2026-10-31', urls: ['https://example.invalid/fresh'], stale: false,
    takeaways: ['Keep the résumé of the run.'] },
];

describe('mixed harness learning digest upgrade', () => {
  it('keeps old citations and new takeaways through the reader and executable refresh checks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'learning-digest-upgrade-'));
    try {
      const file = join(dir, 'digest.md');
      const clock = join(dir, 'clock.cjs');
      const bytes = Buffer.from(markdown, 'utf8');
      writeFileSync(file, bytes);
      // Freeze the executable's clock without changing its CLI or the digest reader.
      writeFileSync(clock, `const RealDate = Date;
global.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : ['2026-10-31T00:36:00Z'])); }
  static now() { return RealDate.parse('2026-10-31T00:36:00Z'); }
};\n`);
      const run = (...args: string[]) => spawnSync(process.execPath, [
        '--require', clock, '--import', 'tsx', resolve('src/cli/index.ts'),
        'reflect', 'harness-digest', '--file', file, '--json', ...args,
      ], { encoding: 'utf8', env: { HOME: dir, PATH: process.env.PATH, TZ: 'UTC' }, timeout: 30_000 });

      const full = { v: 1, sources, issues: [] };
      expect(readHarnessDigest(file, now)).toEqual(full);
      const normal = run();
      expect(normal.error).toBeUndefined();
      expect(normal.status).toBe(0);
      expect(normal.stderr).toBe('');
      expect(JSON.parse(normal.stdout)).toEqual(full);

      const refresh = run('--needs-refresh');
      expect(refresh.error).toBeUndefined();
      expect(refresh.status).toBe(0);
      expect(refresh.stderr).toBe('');
      expect(JSON.parse(refresh.stdout)).toEqual({ v: 1, sources: [sources[1], sources[2]], issues: [] });

      const checked = run('--needs-refresh', '--check');
      expect(checked.error).toBeUndefined();
      expect(checked.status).toBe(1);
      expect(checked.stderr).toBe('');
      expect(JSON.parse(checked.stdout)).toEqual({ v: 1, sources: [sources[1], sources[2]], issues: [] });
      expect(readFileSync(file)).toEqual(bytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
