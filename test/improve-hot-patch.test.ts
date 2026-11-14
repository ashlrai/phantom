import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hotPatchItems, readHotPatchLog } from '../src/core/improve/hot-patch.js';

describe('production hot-patch intake', () => {
  it('creates a deduplicated fix brief with a regression test and no log messages', () => {
    const trace = 'TypeError: private customer data\n    at fn (src/api/server.ts:12:4)\n    at fn (/private/path.ts:3:1)\n';
    const items = hotPatchItems(trace + trace, 'org/repo');
    expect(items).toHaveLength(1);
    expect(items[0]?.prompt).toContain('src/api/server.ts:12:4');
    expect(items[0]?.prompt).toContain('regression test');
    expect(items[0]?.prompt).not.toContain('private');
    expect(hotPatchItems(trace, 'other/repo')[0]?.id).not.toBe(items[0]?.id);
  });
  it('ignores traces without safe relative frames and caps incidents', () => {
    expect(hotPatchItems('Error: secret\n    at /tmp/secret.js:1:2', 'org/repo')).toEqual([]);
    const log = Array.from({ length: 20 }, (_, i) => `Error: x\n    at src/a.ts:${i + 1}:2`).join('\n');
    expect(hotPatchItems(log, 'org/repo')).toHaveLength(10);
  });
  it('reads a bounded tail and discards the truncated first line', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'hot-patch-')), 'log');
    writeFileSync(file, 'x'.repeat(300000) + '\nTypeError: hidden\n    at src/a.ts:1:2\n');
    expect(hotPatchItems(readHotPatchLog(file), 'org/repo')).toHaveLength(1);
  });
});
