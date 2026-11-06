import { describe, expect, it } from 'vitest';
import { REAL_IO_TEST_FILES } from './config/realio-lane-membership.mjs';

/**
 * Regression test added 2026-11-01 (nov01) to prevent the five files below
 * from drifting out of REAL_IO_TEST_FILES — the drift that caused
 * `scripts/check-realio-lane-membership.mjs` to exit non-zero on clean master
 * and made `scripts/verify-changed.mjs` fail for every worker run.
 *
 * One-directional only: these five must remain in the lane.  This test does
 * NOT assert the repo-wide inventory is clean (that is the job of
 * `realio-lane-guard-green.test.ts`), only that these five stay put.
 */
describe('real-I/O lane — nov01 five files', () => {
  const FIVE = [
    'test/fleet-bus-work-claims-01.test.ts',
    'test/fleet-context-run-solu3.test.ts',
    'test/fleet-dirty-union-preview-nov01.test.ts',
    'test/remote-gateway-bus-read-session-nov01.test.ts',
    'test/verify-changed-tsc-cache.test.ts',
  ];

  it('keeps all nov01 files inside REAL_IO_TEST_FILES', () => {
    const set = new Set(REAL_IO_TEST_FILES);
    for (const file of FIVE) {
      expect(set.has(file)).toBe(true);
    }
  });
});
