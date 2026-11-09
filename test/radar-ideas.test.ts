import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectBreakingFlags } from '../src/core/radar/breaking.js';

describe('radar breaking flags', () => {
  it('marks a removed flag used by the repository as fix-now with file and line evidence', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'radar-breaking-'));
    try {
      await writeFile(join(repo, 'example.txt'), 'first\ncommand --old-flag\n');
      expect(detectBreakingFlags('The --old-flag flag was removed.', repo)).toEqual([
        { flag: '--old-flag', priority: 'fix-now', evidence: ['example.txt:2'] },
      ]);
      expect(detectBreakingFlags('The --unused flag was deprecated.', repo)).toEqual([]);
    } finally { await rm(repo, { recursive: true, force: true }); }
  });
});
