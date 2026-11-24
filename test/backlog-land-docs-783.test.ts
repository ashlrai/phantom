import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('PR #7492 maintainer documentation preservation', () => {
  it('links contributors to the existing maintainer section', () => {
    const guide = read('CONTRIBUTING.md');
    expect(guide).toContain('Contributors do not need test-ordering or partition tuning.');
    expect(guide).toContain('(docs/CI-TEST-FEEDBACK.md#duration-weighted-partition-hints)');
    expect(read('docs/CI-TEST-FEEDBACK.md')).toContain('## Duration-weighted partition hints');
    expect(guide).not.toContain('CONVERSION-REQUEST.json > timing-hints.json');
  });

  it('retains opt-in, provenance and qualification constraints with the moved instructions', () => {
    const doc = read('docs/CI-TEST-FEEDBACK.md');
    for (const text of [
      'ASHLR_TEST_CI_WEIGHTED_PARTITION=1',
      'ASHLR_TEST_CI_WEIGHTED_HINTS',
      'phantom-partition-hints/v1',
      'isolated acceptance always ignores these settings',
      'hints cannot replace complete fresh tests or release qualification',
      'phantom-original-report-conversion/v1',
      'manifestSha256', 'qualificationSha256',
      'Saved JSON is not\nauthenticated by this command and grants no release admission',
      'Unknown runner image and\nhardware remain unknown',
      'No hint file is checked in, downloaded, or activated by this conversion',
    ]) expect(doc, text).toContain(text);
    expect(doc).toContain('node .github/scripts/ci-report-weight-hints.mjs CONVERSION-REQUEST.json');
    expect(statSync(resolve(root, '.github/scripts/ci-report-weight-hints.mjs')).isFile()).toBe(true);
    expect(read('llms.txt')).toMatch(/^# Phantom\n/);
  });
});
