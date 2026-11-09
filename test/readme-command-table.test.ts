/**
 * Snapshot of the top-level command list: the README "### Command table" must
 * name every command src/cli/index.ts dispatches, and no others.
 *
 * Adding or removing a top-level command without editing that table fails
 * here. The fixture case proves the check catches an extra command. Reads two
 * text files and imports nothing from the CLI, so it stays well under 5s.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { compareCommandTable, documentedCommands, dispatchedCommands } from './helpers/cli-command-table.js';

const ROOT = join(__dirname, '..');
const indexSource = readFileSync(join(ROOT, 'src', 'cli', 'index.ts'), 'utf8');
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
const dispatched = dispatchedCommands(indexSource);

describe('README command table matches the CLI', () => {
  it('names every dispatched command, and no others', () => {
    const diff = compareCommandTable(dispatched, documentedCommands(readme));
    expect(diff.undocumented, 'add these to the README "### Command table"').toEqual([]);
    expect(diff.unknown, 'remove these from the README "### Command table"').toEqual([]);
    expect(diff.duplicated, 'each command appears once in the README "### Command table"').toEqual([]);
  });

  it('fails on a fixture that dispatches an extra command', () => {
    const fixture = readFileSync(join(__dirname, 'fixtures', 'cli-command-table', 'index-extra-command.ts.txt'), 'utf8');
    const diff = compareCommandTable(dispatchedCommands(fixture), documentedCommands(readme));
    expect(diff.undocumented).toEqual(['phantom-extra']);
  });

  it('fails when the table names a command the CLI no longer dispatches', () => {
    const diff = compareCommandTable(dispatched.filter((name) => name !== 'index'), documentedCommands(readme));
    expect(diff.unknown).toEqual(['index']);
  });

  it('reads the command names out of the table, not the prose', () => {
    const table = '### Command table\n\nSee `phm index` for more.\n\n| Group | Commands |\n| --- | --- |\n| Core | `index`, `go` |\n\n## Next\n| X | `ignored` |\n';
    expect(documentedCommands(table)).toEqual(['index', 'go']);
  });

  it('throws when the README has no command table', () => {
    expect(() => documentedCommands('# no table here\n')).toThrow('"### Command table"');
  });
});
