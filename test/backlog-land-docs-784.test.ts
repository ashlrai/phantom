import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Standalone documentation checker has no declaration output.
import { checkDocumentation } from '../scripts/check-documentation.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

describe('PR #7492 maintainer calibration guidance preservation', () => {
  it('routes contributors to the existing maintainer guide and resolves its anchor', () => {
    const contributing = read('CONTRIBUTING.md');
    expect(contributing).toContain('Contributors do not need test-ordering or partition tuning.');
    expect(contributing).toContain('docs/CI-TEST-FEEDBACK.md#duration-weighted-partition-hints');
    expect(contributing).not.toContain('CONVERSION-REQUEST.json');
    const report = checkDocumentation({
      root, mode: 'source', entrypoints: ['CONTRIBUTING.md', 'docs/CI-TEST-FEEDBACK.md'],
    });
    expect(report.errors).toEqual([]);
    expect(read('llms.txt')).toMatch(/^# Phantom\n/);
  });

  it('retains the opt-in flags, provenance requirements and refusal boundaries together', () => {
    const guide = read('docs/CI-TEST-FEEDBACK.md');
    expect(guide.match(/^## Duration-weighted partition hints$/gm)).toHaveLength(1);
    const section = guide.split('## Duration-weighted partition hints\n')[1] ?? '';
    for (const text of [
      'disabled by default', 'ASHLR_TEST_CI_WEIGHTED_PARTITION=1',
      'ASHLR_TEST_CI_WEIGHTED_HINTS', 'phantom-partition-hints/v1',
      'isolated acceptance always ignores these settings',
      'hints cannot replace complete fresh tests or release qualification',
      'node .github/scripts/ci-report-weight-hints.mjs CONVERSION-REQUEST.json',
      'phantom-original-report-conversion/v1', 'manifestSha256', 'qualificationSha256',
      'phantom-recorded-github-api/v1', 'observedAt',
      'Older captures lacking those inputs refuse',
      'Unknown runner image and\nhardware remain unknown',
      'No hint file is checked in, downloaded, or activated',
    ]) expect(section, text).toContain(text);
    expect(guide).toContain('History affects\nonly priority and never supplies a current pass');
    expect(read('.github/scripts/ci-report-weight-hints.mjs')).toContain('phantom-original-report-conversion/v1');
  });
});
