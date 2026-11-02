import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Standalone Node documentation checker has no declaration output.
import { inspectMarkdown } from '../scripts/check-documentation.mjs';

describe('documentation index package links', () => {
  it('only links relatively to docs included in the curated package', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { files: string[] };
    const index = readFileSync('docs/README.md', 'utf8');
    const missing = (inspectMarkdown(index).links as string[]).flatMap((href) => {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/iu.test(href)) return [];
      const path = decodeURIComponent(href.split(/[?#]/u)[0]);
      const target = posix.normalize(posix.join('docs', path));
      if (!target.startsWith('docs/') || !target.endsWith('.md')) return [];
      return manifest.files.some(file => target === file || target.startsWith(`${file}/`)) ? [] : [href];
    });
    expect(missing).toEqual([]);
  });
});
