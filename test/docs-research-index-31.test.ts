/**
 * Regression guard for docs/research/README.md index entries.
 *
 * Every relative link from `docs/research/README.md` resolves to a real file,
 * and the three canonical docs (TOPICS.md, agent-swarms-rsi.md,
 * speculative-parallel-memory.md) are explicitly linked.  Other jobs may add
 * files to the folder without updating this test.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const RESEARCH_DIR = join(__dirname, '..', 'docs', 'research');
const README_PATH = join(RESEARCH_DIR, 'README.md');

const REQUIRED_LINKS = [
  'TOPICS.md',
  'agent-swarms-rsi.md',
  'speculative-parallel-memory.md',
];

function extractRelativeLinks(content: string): string[] {
  // Matches standard Markdown relative links: [label](path)
  const linkPattern = /\[.+?\]\(([^#\s]+)\)/g;
  const links: string[] = [];
  let match;
  while ((match = linkPattern.exec(content)) !== null) {
    const path = match[1];
    // Skip non-relative links (http, anchors, images, etc.)
    if (!path.startsWith('http') && !path.startsWith('#') && !path.startsWith('data:')) {
      links.push(path);
    }
  }
  return links;
}

describe('docs/research/README.md index', () => {
  it('README.md exists', () => {
    expect(existsSync(README_PATH), 'docs/research/README.md is missing').toBe(true);
  });

  it.each(REQUIRED_LINKS)(
    '%s is linked in README.md',
    (file) => {
      const content = readFileSync(README_PATH, 'utf8');
      const links = extractRelativeLinks(content);
      expect(links).toContain(file);
    },
  );

  it('every relative link resolves to an existing file', () => {
    const content = readFileSync(README_PATH, 'utf8');
    const links = extractRelativeLinks(content);

    for (const link of links) {
      const resolved = join(RESEARCH_DIR, link);
      expect(
        existsSync(resolved),
        `Relative link to "${link}" does not resolve to an existing file (checked as ${relative(RESEARCH_DIR, resolved)})`,
      ).toBe(true);
    }
  });

  it('README.md does not exceed 40 lines', () => {
    const content = readFileSync(README_PATH, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0 || l.length > 0);
    // Count non-empty + trailing newline: file ends with \n giving one extra empty line
    const lineCount = content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
    expect(lineCount).toBeLessThanOrEqual(40);
  });
});
