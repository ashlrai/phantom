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

describe('docs/FAQ.md relative links', () => {
  const content = readFileSync(join(root, 'docs/FAQ.md'), 'utf-8');
  const links = extractRelativeLinks(content);

  it('has 8 unique relative links', () => {
    const unique = [...new Set(links)];
    expect(unique.length).toBe(8);
  });

  it('resolves README.md', () => {
    const target = join(root, 'README.md');
    expect(() => readFileSync(target, 'utf-8')).not.toThrow();
  });

  it('resolves LICENSE', () => {
    const target = join(root, 'LICENSE');
    expect(() => readFileSync(target, 'utf-8')).not.toThrow();
  });

  it('resolves SECURITY.md', () => {
    const target = join(root, 'SECURITY.md');
    expect(() => readFileSync(target, 'utf-8')).not.toThrow();
  });

  it('resolves CONTRIBUTING.md', () => {
    const target = join(root, 'CONTRIBUTING.md');
    expect(() => readFileSync(target, 'utf-8')).not.toThrow();
  });

  it('resolves SUPPORT.md', () => {
    const target = join(root, 'SUPPORT.md');
    expect(() => readFileSync(target, 'utf-8')).not.toThrow();
  });

  it.each(links)('resolves %s', (link) => {
    const target = join(root, link);
    expect(() => readFileSync(target, 'utf-8')).not.toThrow();
  });
});
