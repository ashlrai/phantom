import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  builtDistModules,
  isMarkdownReadingTest,
  requiresBuiltDist,
  selectDocsMarkdownTests,
} from '../.github/scripts/select-docs-markdown-tests.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('docs lane Markdown test selection', () => {
  it('keeps Markdown readers that do not need a built dist', () => {
    // Quoted on purpose so this file stays in the docs-lane selection.
    const sample = 'docs/README.md';
    expect(isMarkdownReadingTest(`readFileSync('${sample}')`)).toBe(true);
    expect(isMarkdownReadingTest('see README.md now')).toBe(false);
    // Split so this file does not match the pattern and drop itself from the lane.
    const helper = 'require-built-' + 'dist.js';
    expect(requiresBuiltDist(`import './helpers/${helper}';`)).toBe(true);
    expect(requiresBuiltDist(`import { x } from './helpers/${helper}';`)).toBe(true);
    expect(requiresBuiltDist(`await import('./helpers/${helper}');`)).toBe(true);
    expect(requiresBuiltDist(`import { y } from './helpers/other.js';`)).toBe(false);
    const viaHelper = `import { y } from './helpers/${'built-release-' + 'inventory'}.js';`;
    expect(requiresBuiltDist(viaHelper, builtDistModules(repoRoot))).toBe(true);
    const { selected, excluded } = selectDocsMarkdownTests(repoRoot);
    // Intended drift guard: a new dist-backed Markdown reader must be added here.
    expect(excluded).toEqual([
      'test/m454.agent-skills-routing-challenge.test.ts',
      'test/m482.release-artifact-contract.test.ts',
    ]);
    expect(selected).toContain('test/docs-markdown-lane.test.ts');
    expect(selected).toContain('test/m454.docs-canaries.test.ts');
    expect(selected).not.toContain('test/m454.agent-skills-routing-challenge.test.ts');
    expect(selected).not.toContain('test/m482.release-artifact-contract.test.ts');
    expect(selected).not.toContain('test/activation-readiness-package.test.ts');
    expect(selected.length).toBeGreaterThan(100);
    expect(selected.some((file) => excluded.includes(file))).toBe(false);
  });
});
