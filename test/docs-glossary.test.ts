/**
 * Validation for docs/GLOSSARY.md — the Phantom fleet vocabulary.
 *
 * Four assertions:
 * 1. The file exists on disk.
 * 2. Every one of the 16 glossary terms appears as a "## " heading.
 * 3. Every relative markdown link resolves to an existing file on origin/master.
 * 4. The file stays under 80 lines (a single-page reference).
 *
 * Fix a missing term by adding its "## " heading, or correct a broken path.
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const GLOSSARY = join(ROOT, 'docs', 'GLOSSARY.md');

const TERMS = [
  'Job',
  'Lane',
  'Tier',
  'Held lane',
  'Queue',
  'Worker',
  'Bridge PR',
  'BRIDGE_NOTES.md',
  'Merge Gate',
  'Runs directory',
  'Switch',
  'Inbox',
  'Interjection',
  'Agent bus',
  'Pane',
  'Leader',
] as const;

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

function extractRelativeMdLinks(text: string): string[] {
  const re = /\[([^\]]+)\]\(([^)]+\.md[^)]*)\)/g;
  const links: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const target = m[2];
    if (target.startsWith('./')) {
      links.push(target.slice(2));
    }
  }
  return links;
}

describe('docs/GLOSSARY.md', () => {
  let lines: string[];
  let existingDocs: Set<string>;

  beforeAll(() => {
    lines = readFileAsLines(GLOSSARY);
    existingDocs = getDocFilesOnMaster();
  });

  it('exists', () => {
    expect(lines.length).toBeGreaterThan(0);
  });

  it('contains a "## " heading for every glossary term', () => {
    const headingLines = lines.filter((l) => l.startsWith('## '));
    for (const term of TERMS) {
      const heading = `## ${term}`;
      const found = headingLines.some((h) => h === heading);
      expect(found, `Missing heading "${heading}"`).toBe(true);
    }
  });

  it('has exactly 16 glossary headings', () => {
    const count = lines.filter((l) => l.startsWith('## ')).length;
    expect(count).toBe(TERMS.length);
  });

  it('all relative markdown links resolve to existing files on origin/master', () => {
    const text = lines.join('\n');
    const links = extractRelativeMdLinks(text);
    expect(links.length).toBeGreaterThanOrEqual(2);
    for (const rel of links) {
      expect(existingDocs.has(`docs/${rel}`), `Link "${rel}" not found on origin/master`).toBe(true);
    }
  });

  it('stays under 80 lines', () => {
    expect(lines.length).toBeLessThan(80);
  });
});
