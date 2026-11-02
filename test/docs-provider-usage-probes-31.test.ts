import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const doc = 'docs/research/provider-usage-probes.md';

// Mirrors the relative-link extraction in test/docs-readme-links.test.ts.
function extractRelativeLinks(content: string): string[] {
  const links: string[] = [];
  const pattern = /\[([^\]]+)\]\(([^)]+)\)/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    const url = match[2]!;
    if (!url.startsWith('http') && !url.startsWith('//')) {
      links.push(url.replace(/#.*$/, ''));
    }
  }
  return links;
}

describe('docs/research/provider-usage-probes.md (RQ-PHX-USAGEPROBERESEARCH31)', () => {
  const content = readFileSync(join(root, doc), 'utf-8');
  const headings = content.split('\n').filter(line => /^#{1,6}\s/.test(line));

  it('stays under 120 lines', () => {
    expect(content.split('\n').length).toBeLessThanOrEqual(120);
  });

  it.each(['Claude Code subscription', 'Anthropic API', 'Codex CLI', 'Devin', 'oMLX'])(
    'names %s as a heading',
    (name) => {
      expect(headings.some(h => h.includes(name)), `a heading containing "${name}"`).toBe(true);
    },
  );

  it('ends with the three smallest fleet changes', () => {
    expect(headings.some(h => h.includes('fleet changes'))).toBe(true);
    const items = content.split('\n').filter(line => /^\d+\.\s/.test(line));
    expect(items).toHaveLength(3);
  });

  const links = extractRelativeLinks(content);

  it('cites repo files with relative links', () => {
    expect(links.length).toBeGreaterThan(0);
  });

  it.each(links)('resolves relative link %s', (link) => {
    const target = join(root, 'docs/research', link);
    expect(() => readFileSync(target, 'utf-8')).not.toThrow();
  });
});
