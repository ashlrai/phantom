import { describe, expect, it } from 'vitest';
import { scoreDiffRisk } from '../../src/fleet/risk.js';
import { patch, rename, scoredFixtures } from './risk-fixtures.js';

describe('diff risk scored fixtures', () => {
  it.each(scoredFixtures)('$name scores $score ($risk)', ({ diff, score, risk }) => {
    expect(scoreDiffRisk(diff)).toMatchObject({ score, risk, measurable: true, invalidReason: null });
  });

  it('reports additions, deletions and test delta independently of source churn', () => {
    expect(scoreDiffRisk(patch('src/widget.ts', ['a', 'b'], ['old']) +
      patch('test/widget.test.ts', ['a', 'b', 'c'], ['old'])).metrics).toEqual({
      files: 2, additions: 5, deletions: 2, changedLines: 7,
      testFiles: 1, testAdditions: 3, testDeletions: 1, testDelta: 2,
    });
  });

  it.each([
    [20, 0, 'low'], [21, 5, 'low'], [100, 5, 'low'], [101, 15, 'low'],
    [400, 15, 'low'], [401, 70, 'high'],
  ] as const)('scores the %i-line boundary', (lines, score, risk) => {
    expect(scoreDiffRisk(patch('docs/guide.md', Array(lines).fill('line'), []))).toMatchObject({ score, risk });
  });

  it.each([[5, 0], [6, 15], [10, 15], [11, 70]])('scores the %i-file boundary', (files, score) => {
    const diff = Array.from({ length: files }, (_, index) => patch(`docs/${index}.md`)).join('');
    expect(scoreDiffRisk(diff).score).toBe(score);
  });

  it('counts deletions toward size rather than netting out replaced lines', () => {
    expect(scoreDiffRisk(patch('docs/guide.md', Array(201).fill('new'), Array(201).fill('old'))))
      .toMatchObject({ score: 70, metrics: { changedLines: 402 } });
  });

  it('never lets unrelated test growth offset shrinking tests or removed assertions', () => {
    const growth = patch('test/extra.test.ts', Array(20).fill('expect(b).toBe(1);'), []);
    const result = scoreDiffRisk(patch('test/widget.test.ts', ['comment'], ['expect(a).toBe(1);']) + growth);
    expect(result).toMatchObject({ score: 85, risk: 'high', metrics: { testDelta: 20 } });
    expect(result.factors).toContainEqual({ code: 'test-tampering', points: 0, minimum: 85, paths: ['test/widget.test.ts'] });
  });

  it('keeps protected and sensitive changes high despite large test additions', () => {
    for (const path of ['src/core/fleet/manager.ts', 'src/security/check.ts', 'package-lock.json', 'CODEOWNERS']) {
      expect(scoreDiffRisk(patch(path) + patch('test/widget.test.ts', Array(30).fill('expect(a).toBe(1);'), [])))
        .toMatchObject({ risk: 'high', score: 85 });
    }
  });

  it.each(['authn', 'authz', 'crypto', 'token', 'tokens', 'password', 'policy', 'sandbox', 'rbac', 'acl', 'session', 'login'])(
    'retains the sensitive %s floor for other repos', (directory) => {
      expect(scoreDiffRisk(patch(`src/${directory}/check.ts`), { selfRepo: false }))
        .toMatchObject({ score: 85, risk: 'high' });
    });

  it('treats executable MDX as source, including under docs', () => {
    expect(scoreDiffRisk(patch('docs/demo.mdx'))).toMatchObject({ score: 45, risk: 'medium' });
  });

  it('classifies security paths case-insensitively and across normalized separators', () => {
    expect(scoreDiffRisk(patch('SRC/AUTHZ/check.ts'), { selfRepo: false }).risk).toBe('high');
    const quoted = patch('src/authz/check.ts')
      .replaceAll('a/src/authz/check.ts', JSON.stringify('a/src\\authz\\check.ts'))
      .replaceAll('b/src/authz/check.ts', JSON.stringify('b/src\\authz\\check.ts'));
    expect(scoreDiffRisk(quoted, { selfRepo: false })).toMatchObject({ risk: 'high', score: 85, measurable: true });
  });

  it('applies self-repo protection by default and supports explicit other-repo scope', () => {
    const diff = patch('src/core/fleet/manager.ts');
    expect(scoreDiffRisk(diff).risk).toBe('high');
    expect(scoreDiffRisk(diff, { selfRepo: false }).risk).toBe('medium');
    expect(scoreDiffRisk(patch('package.json'), { selfRepo: false }).risk).toBe('high');
  });

  it('accepts host evidence about test imports in unchanged or deleted content', () => {
    const result = scoreDiffRisk(patch('test/widget.test.ts'), {
      selfRepo: true, testsImportingTier1: new Set(['test/widget.test.ts']),
    });
    expect(result).toMatchObject({ risk: 'high', score: 85 });
  });

  it('detects newly added Tier-1 imports without caller-provided evidence', () => {
    const specifier = ['..', 'src', 'core', 'fleet', 'manager.js'].join('/');
    expect(scoreDiffRisk(patch('test/widget.test.ts', [`import { judge } from '${specifier}';`], [])))
      .toMatchObject({ score: 85, risk: 'high' });
  });

  it.each(['it.skip', 'test.only', 'describe.skipIf', 'xit'])('flags added %s declarations', (call) => {
    expect(scoreDiffRisk(patch('test/widget.test.ts', [`${call}('x', () => {});`], [])))
      .toMatchObject({ score: 85, risk: 'high' });
  });

  it('allows moved assertions with no net removals', () => {
    expect(scoreDiffRisk(patch('test/widget.test.ts', ['expect(a).toBe(1);'], ['expect(b).toBe(2);'])).risk).toBe('low');
  });

  it('escalates deleted tests and test-runner configuration', () => {
    const deleted = 'diff --git a/test/widget.test.ts b/test/widget.test.ts\ndeleted file mode 100644\n' +
      '--- a/test/widget.test.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old data\n';
    expect(scoreDiffRisk(deleted)).toMatchObject({ risk: 'high', score: 85 });
    expect(scoreDiffRisk(patch('vitest.config.ts'))).toMatchObject({ risk: 'high', score: 85 });
  });

  it('refuses executable-mode changes even on documentation paths', () => {
    const diff = 'diff --git a/docs/guide.md b/docs/guide.md\nold mode 100644\nnew mode 100755\n';
    expect(scoreDiffRisk(diff).risk).toBe('high');
  });

  it.each([
    patch('docs/guide.md').replace('100644', '100755'),
    patch('docs/guide.md').replace('index 1111111..2222222 100644', 'old mode 100644\nnew mode 100755\nindex 1111111..2222222'),
    patch('docs/guide.md').replace('index 1111111..2222222 100644', 'old mode 100755\nnew mode 100644\nindex 1111111..2222222'),
  ])('scores executable content edits as high %#', (diff) => {
    const result = scoreDiffRisk(diff);
    expect(result).toMatchObject({ risk: 'high', score: 85, measurable: true });
    expect(result.factors).toContainEqual({ code: 'executable-mode', points: 0, minimum: 85, paths: [] });
  });

  it('returns stable, detached, serializable evidence without patch contents', () => {
    const diff = patch('src/widget.ts', ['private implementation'], ['old']);
    const first = scoreDiffRisk(diff);
    const serialized = JSON.stringify(first);
    expect(JSON.parse(serialized)).toEqual(scoreDiffRisk(diff));
    expect(serialized).not.toContain('private implementation');
    first.factors[0].paths.push('mutated');
    expect(JSON.stringify(scoreDiffRisk(diff))).toBe(serialized);
  });

  it('is independent of file order', () => {
    const a = patch('src/widget.ts'); const b = patch('test/widget.test.ts');
    expect(scoreDiffRisk(a + b)).toEqual(scoreDiffRisk(b + a));
  });
});

describe('unmeasurable patches fail closed', () => {
  it.each([
    null, undefined, '', 'not a patch', patch('../escape.md'), patch('C:/escape.md'), patch('.git/config'),
    patch('docs/guide.md').replace('@@ -1,1 +1,1 @@', '@@ -1,2 +1,1 @@'),
    patch('docs/guide.md') + patch('docs/guide.md'),
    'diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\n',
    'diff --git a/link b/link\nnew file mode 120000\n',
    'diff --git a/submodule b/submodule\nnew file mode 160000\n',
    rename('src/auth/check.ts', 'docs/guide.md'),
    'x'.repeat(8 * 1024 * 1024 + 1),
  ])('escalates invalid or unsupported input %#', (diff) => {
    expect(scoreDiffRisk(diff)).toMatchObject({ score: 100, risk: 'high', measurable: false, metrics: null });
    expect(scoreDiffRisk(diff).invalidReason).toBeTruthy();
  });
});
