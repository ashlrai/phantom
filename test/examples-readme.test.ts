import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const EXAMPLES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'examples',
);
const README_PATH = join(EXAMPLES_DIR, 'README.md');

function readExamplesDir(): string[] {
  const entries = readdirSync(EXAMPLES_DIR).sort();
  return entries.filter(e => e !== 'README.md');
}

function extractMarkdownLinks(text: string): string[] {
  const links: string[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/\[([^\]]+)\]\(([^)]+)\)/);
    if (m) {
      links.push(m[2].replace(/\/+$/, ''));
    }
  }
  return links;
}

const entries = readExamplesDir();
const readmeText = readFileSync(README_PATH, 'utf8');
const links = extractMarkdownLinks(readmeText);

describe('examples/README.md', () => {
  it('links every non-README entry in examples/', () => {
    const linked: Set<string> = new Set(links);
    for (const entry of entries) {
      expect(linked).toContain(
        entry,
        `examples/README.md should link ${entry}`,
      );
    }
  });

  it('every relative link resolves to an existing file or directory', () => {
    for (const link of links) {
      const abs = join(EXAMPLES_DIR, link);
      const exists = existsSync(abs);
      expect(exists, `${link} should exist under examples/`).toBe(true);
    }
  });

  it('every example entry appears in the table body', () => {
    const lines = readmeText.split('\n');
    const tableRows = lines.filter(
      (l: string) =>
        l.includes('|') &&
        !l.startsWith('#') &&
        !l.startsWith('---') &&
        !l.startsWith('| Entry') &&
        l.includes(']('),
    );
    for (const entry of entries) {
      const linkedRows = tableRows.filter((r: string) =>
        r.includes(`](${entry})`) || r.includes(`](${entry}/)`),
      );
      expect(
        linkedRows.length > 0,
        `${entry} should appear in a table row of examples/README.md`,
      ).toBe(true);
    }
  });
});
