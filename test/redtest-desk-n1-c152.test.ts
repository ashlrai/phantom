/**
 * RQ-PHX-REDTESTDESKN1C152: regression for the #5070 recut.
 *
 * The PR adds test/comms-send-policy-typefix-s133.test.ts, whose `policy`
 * name stem makes it a Tier-1 test under merge gate G1
 * (src/core/authority/protected-paths.ts TIER1_TEST_STEMS). Tier-1 tests must
 * be listed in the generated owner-lane block of .github/CODEOWNERS or the
 * Quick typecheck "Check authority drift" step fails — the only red check on
 * the PR. Mason sees this as GitHub requiring his code-owner review on the
 * new suite.
 *
 * This file deliberately avoids importing Tier-1 source and Tier-1 name
 * stems so it stays outside the owner lane itself.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CODEOWNERS = readFileSync(join(import.meta.dirname, '..', '.github', 'CODEOWNERS'), 'utf8');
const TIER1_SUITE = '/test/comms-send-policy-typefix-s133.test.ts';
const OWNER = '@masonwyatt23';

describe('CODEOWNERS covers the #5070 send-policy Tier-1 suite', () => {
  it('lists the suite in the generated owner-lane block', () => {
    const lines = CODEOWNERS.split('\n').filter((line) => line.trim() && !line.startsWith('#'));
    expect(lines).toContain(`${TIER1_SUITE} ${OWNER}`);
  });

  it('keeps the suite inside the generated block, after the last rule comment', () => {
    const entry = CODEOWNERS.indexOf(`${TIER1_SUITE} ${OWNER}`);
    const marker = CODEOWNERS.indexOf('# Generated from src/core/authority/protected-paths.ts');
    expect(marker).toBeGreaterThanOrEqual(0);
    expect(entry).toBeGreaterThan(marker);
  });
});
