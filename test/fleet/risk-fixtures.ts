/** Canonical patches with explicit modes and exact hunk counts. */
export function patch(path: string, added: string[] = ['after'], removed: string[] = ['before']): string {
  return [
    `diff --git a/${path} b/${path}`, 'index 1111111..2222222 100644',
    `--- a/${path}`, `+++ b/${path}`,
    `@@ -${removed.length ? 1 : 0},${removed.length} +${added.length ? 1 : 0},${added.length} @@`,
    ...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`), '',
  ].join('\n');
}

export function rename(from: string, to: string): string {
  return `diff --git a/${from} b/${to}\nsimilarity index 100%\nrename from ${from}\nrename to ${to}\n`;
}

export const scoredFixtures = [
  { name: 'small docs', diff: patch('docs/guide.md'), score: 0, risk: 'low' },
  { name: 'test growth', diff: patch('test/widget.test.ts', ['expect(a).toBe(1);'], []), score: 5, risk: 'low' },
  { name: 'source without tests', diff: patch('src/widget.ts'), score: 45, risk: 'medium' },
  { name: 'source with growing tests', diff: patch('src/widget.ts') +
    patch('test/widget.test.ts', ['expect(a).toBe(1);'], []), score: 30, risk: 'medium' },
  { name: 'source with flat tests', diff: patch('src/widget.ts') +
    patch('test/widget.test.ts', ['expect(a).toBe(2);'], ['expect(a).toBe(1);']), score: 40, risk: 'medium' },
  { name: 'configuration', diff: patch('settings.toml'), score: 35, risk: 'medium' },
  { name: 'manifest', diff: patch('package.json'), score: 85, risk: 'high' },
  { name: 'CI', diff: patch('.github/workflows/check.yml'), score: 85, risk: 'high' },
  { name: 'security', diff: patch('src/auth/login.ts'), score: 85, risk: 'high' },
  { name: 'unknown file', diff: patch('art.blob'), score: 70, risk: 'high' },
  { name: 'shrinking test data', diff: patch('test/widget.test.ts', ['data'], ['old data', 'more data']), score: 70, risk: 'high' },
  { name: 'removed assertion', diff: patch('test/widget.test.ts', ['comment'], ['expect(a).toBe(1);']), score: 85, risk: 'high' },
  { name: 'focused test', diff: patch('test/widget.test.ts', ["it.only('x', () => {});"], []), score: 85, risk: 'high' },
  { name: 'snapshot edit', diff: patch('test/__snapshots__/widget.snap'), score: 85, risk: 'high' },
  { name: 'shell', diff: patch('tools/run.sh'), score: 85, risk: 'high' },
  { name: 'large doc', diff: patch('docs/guide.md', Array(401).fill('new'), []), score: 70, risk: 'high' },
] as const;
