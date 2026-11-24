import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// node:test suites outside the vitest globs (scripts/, tests/) run through
// the same bridge as test/deletion-sweep.test.mjs: a collected suite spawns
// `node --test` on each .mjs file. test/test-file-collection.test.ts fails
// if one of these literals drifts from the file on disk.
const SUITES = [
  'scripts/verify-changed-slots.test.mjs',
  'scripts/metrics-outcomes.test.mjs',
  'tests/merge-drain-q9.test.mjs',
] as const;

describe('node:test script suites', () => {
  for (const suite of SUITES) {
    it(`runs ${suite}`, () => {
      const result = spawnSync(process.execPath, ['--test', resolve(suite)], {
        cwd: resolve('.'), encoding: 'utf8', timeout: 60_000,
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
    });
  }
});
