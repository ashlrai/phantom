import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');

// RQ-PHX-REDTESTFIXN1C152 regression for PR #5068. The recovered suite arrived
// as test/intent-merge-receipt-recovery-151.test.ts: its 'merge' basename
// token hits the Tier-1 test stems in matchProtectedPath, so G1 classified it
// tier1-test and authority-codeowners-310b failed demanding a CODEOWNERS line
// only the owner may add. The suite guards intent-ledger receipt logic, not
// merge gates, so the fix keeps it under a name that says what it tests.
// This file intentionally imports no Tier-1 source: importing
// src/core/authority/** would make this very suite Tier-1 and repeat the bug.
const SUITE = 'test/intent-receipt-recovery-151.test.ts';
const TIER1_STEM_NAME = 'test/intent-merge-receipt-recovery-151.test.ts';

it('lands the recovered intent receipt suite under a non-Tier-1 name', () => {
  expect(existsSync(join(ROOT, SUITE)), `${SUITE} must exist (renamed from the Tier-1-stem name)`).toBe(true);
  expect(existsSync(join(ROOT, TIER1_STEM_NAME)), `${TIER1_STEM_NAME} is the name that failed authority drift`).toBe(false);
});

it('no test/ file reintroduces the recovered suite under a Tier-1 stem', () => {
  // The exact failure mode: basename token 'merge' inside an intent receipt
  // suite name. Tokenised on the same [._-] separators the classifier uses.
  const offenders = readdirSync(join(ROOT, 'test'))
    .filter((name) => name.includes('receipt') && /(?:^|[._-])merge(?:[._-]|$)/.test(name));
  expect(offenders).toEqual([]);
});
