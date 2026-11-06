import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const DOC_PATH = join(root, 'docs/SECOND-COMPUTER-OPTIONS.md');
const DOC_URL = 'https://github.com/ashlrai/phantom/blob/master/docs/SECOND-COMPUTER-OPTIONS.md';

function optionRows(document: string): string[][] {
  return document
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\|.*\|$/.test(line))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) =>
      cells.length >= 8 &&
      !/^:?-+:?$/.test(cells[0]) &&
      !/^option$/i.test(cells[0]));
}

describe('docs/SECOND-COMPUTER-OPTIONS.md', () => {
  const document = readFileSync(DOC_PATH, 'utf-8');
  const rows = optionRows(document);

  it('lists at least five priced options', () => {
    expect(rows.length).toBeGreaterThanOrEqual(5);
  });

  it.each(rows.map((row) => [row[0], row] as const))(
    'row "%s" has an https source URL and a date or the word unverified',
    (_name, row) => {
      expect(row.join(' ')).toMatch(/https:\/\/\S+/);
      expect(row.join(' ')).toMatch(/\d{4}-\d{2}-\d{2}|unverified/i);
    });

  it.each(rows.map((row) => [row[0], row] as const))(
    'row "%s" marks Safari and iCloud possible as yes or no',
    (_name, row) => {
      expect(row[4].toLowerCase()).toMatch(/^(yes|no)$/);
    });

  it('ends on a line stating nothing has been bought', () => {
    const lastLine = document.trim().split('\n').at(-1) ?? '';
    expect(lastLine).toMatch(/nothing has been bought/i);
  });

  it('is linked from docs/README.md by absolute URL', () => {
    const readme = readFileSync(join(root, 'docs/README.md'), 'utf-8');
    expect(readme).toContain(DOC_URL);
  });
});
