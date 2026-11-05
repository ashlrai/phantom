/**
 * Validation for docs/llms.txt — the machine-readable Phantom docs map.
 *
 * Two assertions:
 * 1. The file begins with "# Phantom" (llmstxt.org H1 convention).
 * 2. Every relative markdown link in the file resolves to an existing
 *    file — either on `origin/master` (already published) or in this
 *    working tree (a page added by the same change, in flight to master).
 *    Links are resolved against `docs/`, so `../` targets outside `docs/`
 *    (repo-root pages like DESKTOP.md or contrib/) count too.
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

function getResolvableFiles(): Set<string> {
  const env = { ...process.env, HOME: '/tmp' };
  const onMaster = execSync(
    'git ls-tree -r --name-only origin/master',
    { cwd: ROOT, encoding: 'utf-8', env },
  );
  const inTree = execSync(
    'git ls-files --cached --others --exclude-standard',
    { cwd: ROOT, encoding: 'utf-8', env },
  );
  return new Set(
    `${onMaster}\n${inTree}`.split('\n').map((f) => f.trim()).filter(Boolean),
  );
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

  it('all relative markdown links resolve to existing files on origin/master or in the tree', () => {
    const lines = readFileAsLines(LLMS_TXT);
    const existingFiles = getResolvableFiles();
    const links = extractLinks(lines);

    expect(links.length).toBeGreaterThan(0, 'llms.txt should contain at least one link');

    for (const relPath of links) {
      const fullDocPath = join('docs', relPath.split('#')[0]!);
      expect(
        existingFiles.has(fullDocPath),
        `Link target "${fullDocPath}" exists neither on origin/master nor in the working tree`,
      ).toBe(true);
    }
  });
});
