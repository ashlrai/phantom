import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function extractRelativeLinks(content: string): string[] {
  const links: string[] = [];
  const pattern = /\[([^\]]+)\]\(([^)]+\.md[^)]*)\)/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    const url = match[2];
    // Only capture relative links (not https://...)
    if (!url.startsWith('http') && !url.startsWith('//')) {
      // Strip anchors (section references) for file resolution
      links.push(url.replace(/#.*$/, ''));
    }
  }
  return links;
}

describe('docs/README.md relative links', () => {
  const content = readFileSync(join(root, 'docs/README.md'), 'utf-8');
  const links = extractRelativeLinks(content);

  it('has at least one relative link', () => {
    expect(links.length).toBeGreaterThan(0);
  });

  it.each(links)('resolves %s', (link) => {
    const target = join(root, 'docs', link);
    expect(() => readFileSync(target, 'utf-8')).not.toThrow();
  });
});
