/**
 * Validation for docs/llms.txt — the machine-readable Phantom docs map.
 *
 * Two assertions:
 * 1. The file begins with "# Phantom" (llmstxt.org H1 convention).
 * 2. Every relative markdown link in the file resolves to an existing
 *    file on `origin/master`.
 *
 * Fix a broken link by removing the entry or correcting the path.
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const LLMS_TXT = join(ROOT, 'docs', 'llms.txt');

function readFileAsLines(filePath: string): string[] {
  return readFileSync(filePath, 'utf-8').split('\n');
}

function getDocFilesOnMaster(): Set<string> {
  const output = execSync(
    'git ls-tree -r --name-only origin/master -- docs/ | grep "\\.md$"',
    { cwd: ROOT, encoding: 'utf-8', env: { ...process.env, HOME: '/tmp' } },
  );
  return new Set(output.trim().split('\n').filter(Boolean));
}

function extractLinks(lines: string[]): string[] {
  const linkRegex = /\[([^\]]+)\]\(([^)]+\.md[^)]*)\)/g;
  const links: string[] = [];
  let match;
  while ((match = linkRegex.exec(lines.join('\n'))) !== null) {
    links.push(match[2]);
  }
  return links;
}

describe('docs/llms.txt', () => {
  it('starts with "# Phantom"', () => {
    const lines = readFileAsLines(LLMS_TXT);
    expect(lines[0]).toBe('# Phantom');
  });

  it('all relative markdown links resolve to existing files on origin/master', () => {
    const lines = readFileAsLines(LLMS_TXT);
    const existingDocs = getDocFilesOnMaster();
    const links = extractLinks(lines);

    expect(links.length).toBeGreaterThan(0, 'llms.txt should contain at least one link');

    for (const relPath of links) {
      const fullDocPath = join('docs', relPath);
      expect(
        existingDocs.has(fullDocPath),
        `Link target "${fullDocPath}" does not exist on origin/master`,
      ).toBe(true);
    }
  });
});
