import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  isTier1TestPath,
  matchProtectedPath,
  testContentImportsTier1,
} from '../src/core/authority/protected-paths.js';

const ROOT = join(import.meta.dirname, '..');
const TEST_PATH = 'test/merge-identity-recut.test.ts';
const DOC_PATH = 'docs/MERGE-IDENTITY.md';

describe('RQ-PHX-REDTYPEFIXC175 fix of #5130', () => {
  it('classes the recut test as Tier-1 through G1, so CODEOWNERS must own it', () => {
    const content = readFileSync(join(ROOT, TEST_PATH), 'utf8');
    expect(isTier1TestPath(TEST_PATH)).toBe(true);
    expect(matchProtectedPath(TEST_PATH, {
      selfRepo: true,
      testsImportingTier1: new Set(testContentImportsTier1(TEST_PATH, [content]) ? [TEST_PATH] : []),
    })).toMatchObject({ ruleId: 'tier1-test' });
  });

  it('keeps the generated CODEOWNERS line for the new Tier-1 test', () => {
    const codeowners = readFileSync(join(ROOT, '.github', 'CODEOWNERS'), 'utf8');
    expect(codeowners).toContain(`/${TEST_PATH} @masonwyatt23`);
  });

  it('indexes the new doc page in generated docs/llms.txt', () => {
    const llms = readFileSync(join(ROOT, 'docs', 'llms.txt'), 'utf8');
    expect(llms).toContain('[Merge identity](MERGE-IDENTITY.md)');
    expect(readFileSync(join(ROOT, DOC_PATH), 'utf8')).toContain('# Merge identity');
  });
});
