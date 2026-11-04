// Whole-repo documentation navigation guard: walks every Markdown file under
// docs/ (recursively) plus each top-level *.md, and fails on any relative link
// or #anchor that does not resolve — file missing, target outside the repo, or
// dead heading/explicit anchor in a Markdown target. `scripts/check-documentation.mjs`
// does the resolution; unlike `npm run check:docs`, which checks only the
// curated operator entrypoints, this walks the full tree so no page opt-outs.
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Standalone Node documentation checker has no declaration output.
import { checkDocumentation } from '../scripts/check-documentation.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function collectMarkdownFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.md')) files.push(relative(ROOT, path));
    }
  };
  walk(join(ROOT, 'docs'));
  for (const name of readdirSync(ROOT)) {
    if (statSync(join(ROOT, name)).isFile() && name.endsWith('.md')) files.push(name);
  }
  return files.sort();
}

describe('repository documentation link graph', () => {
  const entrypoints = collectMarkdownFiles();

  it('walks the whole docs tree plus the top-level pages', () => {
    expect(entrypoints.length).toBeGreaterThan(50);
    for (const required of ['README.md', 'CHANGELOG.md', 'docs/README.md', 'docs/CHANNELS.md', 'docs/FAQ.md']) {
      expect(entrypoints, `walker missed ${required}`).toContain(required);
    }
  });

  // ~300 documents including the 300+ KiB CHANGELOG; measured ~5s locally, so
  // give the parse a wide explicit budget instead of the 5s lane default.
  it('resolves every relative link and anchor target', { timeout: 30_000 }, () => {
    const result = checkDocumentation({ root: ROOT, entrypoints }) as ReturnType<typeof checkDocumentation>;
    const failures = result.errors.map((error: { file: string; href: string | null; reason: string }) =>
      `${error.file} -> ${error.href ?? '(document)'}: ${error.reason}`);
    expect(failures, `${entrypoints.length} documents, ${result.localLinks} relative links checked`)
      .toEqual([]);
    expect(result.localLinks).toBeGreaterThan(0);
    expect(result.externalRequests).toBe(0);
  });
});
