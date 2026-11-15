/**
 * RQ-PHX-REDTESTFIXC205 — regression pin for the #5247 bridge fix.
 *
 * #5247 preserves test/merge-plan-original-preservation-202s.test.ts, a
 * preserved fleet merge-plan regression suite. Its basename carries the
 * Tier-1 stem `merge`, so G1 (matchProtectedPath, self-repo) classifies it as
 * a Tier-1 test and .github/CODEOWNERS must name it — but the PR added the
 * file without regenerating CODEOWNERS, so
 * test/authority-codeowners-310b.test.ts failed inside the Quick typecheck
 * job's "Check authority drift (hermetic)" step while `npm run typecheck`
 * stayed green.
 *
 * This pins the corrected end state through the real classifiers:
 *   1. The preserved file is a Tier-1 test path under G1's own rules.
 *   2. matchProtectedPath returns the tier1-test hit for it.
 *   3. .github/CODEOWNERS carries the generated owner line for it inside the
 *      generated block (the same bytes ASHLR_UPDATE_CODEOWNERS=1 emits).
 *
 * Hermetic: reads repo files read-only; no network, no temp state.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { isTier1TestPath, matchProtectedPath } from '../src/core/authority/protected-paths.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PRESERVED = 'test/merge-plan-original-preservation-202s.test.ts';
const CODEOWNERS_PATH = join(ROOT, '.github', 'CODEOWNERS');
const OWNER = '@masonwyatt23';
const MARKER = '# Generated from src/core/authority/protected-paths.ts';

describe('RQ-PHX-REDTESTFIXC205: preserved merge-plan suite stays owner-lane', () => {
  it('the preserved file exists and is a Tier-1 test under G1', () => {
    const content = readFileSync(join(ROOT, PRESERVED), 'utf8');
    expect(content).toContain('cmdFleetMergePlan');
    expect(isTier1TestPath(PRESERVED)).toBe(true);
    const hit = matchProtectedPath(PRESERVED, { selfRepo: true });
    expect(hit?.ruleId).toBe('tier1-test');
  });

  it('.github/CODEOWNERS names the preserved file inside the generated block', () => {
    const codeowners = readFileSync(CODEOWNERS_PATH, 'utf8');
    const at = codeowners.indexOf(MARKER);
    expect(at, 'generated block marker not found').toBeGreaterThanOrEqual(0);
    const expected = `/${PRESERVED} ${OWNER}`;
    expect(codeowners.slice(at).split('\n')).toContain(expected);
  });
});
