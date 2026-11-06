import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

/** Extract `[text](relative-path)` links from markdown text. */
function relativeLinks(text: string): string[] {
  const re = /\[([^\]]+)\]\(([^#\s][^)]*)\)/g;
  const results: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const href = m[2].trim();
    // Only relative paths (no http, no anchor-only, no fragments)
    if (href && !href.startsWith('#') && !href.startsWith('http') && !href.startsWith('mailto:')) {
      results.push(href);
    }
  }
  return results;
}

const govt = readFileSync(resolve(repoRoot, 'GOVERNANCE.md'), 'utf-8');
const links = relativeLinks(govt);

describe('GOVERNANCE.md link resolution', () => {
  it('links CONTRIBUTING.md', () => {
    expect(links).toContain('CONTRIBUTING.md');
  });

  it('links SECURITY.md', () => {
    expect(links).toContain('SECURITY.md');
  });

  it.each(links)('relative link %s resolves to an existing file', (rel: string) => {
    const target = resolve(repoRoot, rel);
    expect(() => readFileSync(target, 'utf-8')).not.toThrow();
  });
});
