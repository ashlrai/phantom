import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  isMarkdownReadingTest,
  selectDocsMarkdownTests,
} from '../.github/scripts/select-docs-markdown-tests.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('docs lane Markdown test selection', () => {
  it('keeps Markdown readers that do not need a built dist', () => {
    // Quoted on purpose so this file stays in the docs-lane selection.
    const sample = 'docs/README.md';
    expect(isMarkdownReadingTest(`readFileSync('${sample}')`)).toBe(true);
    expect(isMarkdownReadingTest('see README.md now')).toBe(false);
    const { selected, excluded } = selectDocsMarkdownTests(repoRoot);
    expect(excluded).toEqual([
      'test/m454.agent-skills-routing-challenge.test.ts',
      'test/m482.release-artifact-contract.test.ts',
    ]);
    expect(selected).toContain('test/docs-markdown-lane.test.ts');
    expect(selected).not.toContain('test/m454.agent-skills-routing-challenge.test.ts');
    expect(selected).not.toContain('test/m482.release-artifact-contract.test.ts');
    expect(selected).not.toContain('test/activation-readiness-package.test.ts');
    expect(selected.length).toBeGreaterThan(100);
    expect(selected.some((file) => excluded.includes(file))).toBe(false);
  });
});
