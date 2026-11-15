/**
 * docs/lanes.md contract: one plain-words row per fleet lane, linked from the
 * README and the docs index, with the agent commands it names still real.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const LANES = [
  'codex-personal', 'codex-cmp', 'claude', 'claude-api', 'devin', 'codex-local',
  'zai', 'gemini', 'grok', 'cursor', 'agy',
] as const;

const lanesDoc = read('docs/lanes.md');
const rows = lanesDoc
  .split('\n')
  .filter((line) => /^\| `[a-z0-9-]+` \|/.test(line))
  .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));

describe('docs/lanes.md', () => {
  it('has exactly one row per fleet lane, in the order the fleet lists them', () => {
    expect(rows.map((cells) => cells[0]!.replace(/`/g, ''))).toEqual([...LANES]);
  });

  it('gives every lane a runs-on and a best-at cell', () => {
    for (const cells of rows) {
      expect(cells).toHaveLength(3);
      for (const cell of cells) expect(cell.length).toBeGreaterThan(0);
    }
  });

  it('keeps each cell short and plain (one line, under 30 words)', () => {
    for (const cells of rows) {
      for (const cell of cells.slice(1)) {
        expect(cell.split(/\s+/).length, cell).toBeLessThan(30);
      }
    }
  });

  it('says plainly which lanes are not job lanes yet', () => {
    const notYet = rows.filter((cells) => cells[2]!.includes('Not a job lane yet'))
      .map((cells) => cells[0]!.replace(/`/g, ''));
    expect(notYet).toEqual(['gemini', 'grok']);
  });

  it('names the agent commands, and both still exist in the CLI', () => {
    expect(lanesDoc).toContain('phm lanes health --json');
    expect(lanesDoc).toContain('phm lanes fit --lane codex-personal --json');
    expect(read('src/cli/lanes.ts')).toContain('phm lanes health [--json] | phm lanes fit --lane <lane> [--json]');
  });
});

describe('docs/lanes.md links', () => {
  it('is linked from the README', () => {
    expect(read('README.md')).toContain('[docs/lanes.md](docs/lanes.md)');
  });

  it('is linked from the docs index', () => {
    expect(read('docs/README.md')).toContain('[Fleet lanes](lanes.md)');
  });

  it('is in the npm package file list, so the packaged README link resolves', () => {
    const manifest = JSON.parse(read('package.json')) as { files: string[] };
    expect(manifest.files).toContain('docs/lanes.md');
  });
});
