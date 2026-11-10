/**
 * RQ-MERGE-FRIENDLY-1 (recut of #4543): the CLI registries that every command
 * PR touches must stay in a layout where concurrent PRs do not collide. The
 * completions command list is derived from HELP_ENTRIES, SUBCOMMANDS stays
 * sorted one entry per line, and the sorter's --check is the guard.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOP_LEVEL_COMMANDS } from '../src/cli/completions.js';
import { HELP_ENTRIES } from '../src/cli/help.js';
import { sortHelpEntriesSource, sortSubcommandsSource } from '../scripts/lib/cli-registry-sort.mjs';
import { sortCliRegistries } from '../scripts/sort-cli-registries.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string): string => readFileSync(join(ROOT, file), 'utf8');

describe('sorted one-entry-per-line registries', () => {
  it('completions.ts is already in canonical order', () => {
    expect(sortCliRegistries({ check: true, base: ROOT })).toEqual([]);
  });

  it('the CLI entry point --check exits 0 on the committed tree', () => {
    const out = execFileSync(process.execPath, [join(ROOT, 'scripts/sort-cli-registries.mjs'), '--check'], {
      cwd: ROOT, encoding: 'utf8',
    });
    expect(out).toBe('');
  });

  it('help.ts HELP_ENTRIES parses as one single-line entry each (ready for --all)', () => {
    // Throws on any multi-line entry, so a new command cannot break the layout
    // the opt-in --all resort depends on.
    const source = read('src/cli/help.ts');
    const lines = (text: string): string[] => text.split('\n').filter((l) => l.trim() !== '').sort();
    expect(lines(sortHelpEntriesSource(source))).toEqual(lines(source));
  });

  it('a new help entry inserted anywhere is moved to its sorted slot', () => {
    const src = [
      'export const HELP_ENTRIES: HelpEntry[] = [',
      "  { cmd: 'beta', desc: 'b', topic: 'core' },",
      '',
      "  { cmd: 'zeta', desc: 'z', topic: 'core' },",
      "  { cmd: 'alpha [--json]', desc: 'a', topic: 'core' },",
      '];',
    ].join('\n');
    const out = sortHelpEntriesSource(src).split('\n');
    expect(out.slice(1, 4).map((l) => /cmd: '(\w+)/.exec(l)?.[1])).toEqual(['alpha', 'beta', 'zeta']);
    expect(() => sortHelpEntriesSource(src.replace("{ cmd: 'zeta'", '{\n    cmd: \'zeta\''))).toThrow(/single-line/);
  });

  it('SUBCOMMANDS collapses multi-line entries, keeps comments, rejects duplicates', () => {
    const src = [
      'const SUBCOMMANDS: Record<string, string[]> = {',
      "  zed: ['a'],",
      '  // about beta',
      '  beta: [',
      "    'x', 'y',",
      '  ],',
      '};',
    ].join('\n');
    expect(sortSubcommandsSource(src)).toBe([
      'const SUBCOMMANDS: Record<string, string[]> = {',
      '  // about beta',
      "  beta: ['x', 'y'],",
      "  zed: ['a'],",
      '};',
    ].join('\n'));
    expect(() => sortSubcommandsSource(src.replace('zed', 'beta'))).toThrow(/duplicate/);
  });

  it('every SUBCOMMANDS entry in completions.ts is a single line', () => {
    const body = read('src/cli/completions.ts').split('const SUBCOMMANDS')[1]!.split('\n};')[0]!;
    const bad = body.split('\n').slice(1).filter((l) => l.trim() && !/^\s*\/\//.test(l) && !/^ {2}\S.*: \[.*\],$/.test(l));
    expect(bad).toEqual([]);
  });
});

describe('completions derive from the help table', () => {
  it('TOP_LEVEL_COMMANDS is exactly the unique first words of HELP_ENTRIES, sorted, no duplicates', () => {
    const expected = [...new Set(HELP_ENTRIES.map((e) => e.cmd.split(/\s+/)[0]))].sort();
    expect(TOP_LEVEL_COMMANDS).toEqual(expected);
    expect(new Set(TOP_LEVEL_COMMANDS).size).toBe(TOP_LEVEL_COMMANDS.length);
  });

  it('a command documented only in help is now completable (the old copy had drifted)', () => {
    expect(TOP_LEVEL_COMMANDS).toContain('constitution');
  });

  it('completions.ts no longer carries a hand-written command list', () => {
    expect(read('src/cli/completions.ts')).not.toMatch(/TOP_LEVEL_COMMANDS: string\[\] = \[\s*'/);
  });
});

