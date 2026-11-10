/**
 * RQ-MERGE-FRIENDLY-1: the CLI registries that every command PR touches must
 * stay in a layout where concurrent PRs do not collide, and the .gitattributes
 * union rules must stay limited to files where a union merge is safe.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOP_LEVEL_COMMANDS } from '../src/cli/completions.js';
import { HELP_ENTRIES } from '../src/cli/help.js';
import { sortHelpEntriesSource, sortSubcommandsSource } from '../scripts/lib/cli-registry-sort.mjs';
import { sortCliRegistries } from '../scripts/sort-cli-registries.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string): string => readFileSync(join(ROOT, file), 'utf8');

describe('sorted one-entry-per-line registries', () => {
  it('help.ts and completions.ts are already in canonical order', () => {
    expect(sortCliRegistries({ check: true, base: ROOT })).toEqual([]);
  });

  it('HELP_ENTRIES is sorted by command text', () => {
    const cmds = HELP_ENTRIES.map((e) => e.cmd);
    expect(cmds).toEqual([...cmds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
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

  it('completions.ts no longer carries a hand-written command list', () => {
    expect(read('src/cli/completions.ts')).not.toMatch(/TOP_LEVEL_COMMANDS: string\[\] = \[\s*'/);
  });
});

describe('.gitattributes union rules', () => {
  const rules = read('.gitattributes').split('\n').filter((l) => /\bmerge=union\b/.test(l) && !l.startsWith('#'))
    .map((l) => l.split(/\s+/)[0]!);

  it('only unions docs indexes, changelogs and the generated fleet registry', () => {
    const allowed = (p: string): boolean => /(^|\/)CHANGELOG\.md$/.test(p) || /^docs\/[\w.-]+\.(md|txt)$/.test(p)
      || p === 'src/cli/fleet-subcommand-registry.ts';
    expect(rules.filter((p) => !allowed(p))).toEqual([]);
    expect(rules).toEqual(expect.arrayContaining(['docs/README.md', 'docs/llms.txt', 'src/cli/fleet-subcommand-registry.ts']));
  });

  it('never unions hand-written logic (help/completions/index/config)', () => {
    for (const p of ['src/cli/help.ts', 'src/cli/completions.ts', 'src/cli/index.ts', 'test/config/realio-lane-membership.mjs']) {
      expect(rules).not.toContain(p);
    }
  });

  it('two branches that each add a different line at the same spot merge without conflict', () => {
    const dir = mkdtempSync(join(tmpdir(), 'merge-friendly-'));
    const git = (...args: string[]): string => execFileSync('git', args, {
      cwd: dir, encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: dir, GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' },
    });
    try {
      git('init', '-q', '-b', 'main');
      writeFileSync(join(dir, '.gitattributes'), read('.gitattributes'));
      mkdirSync(join(dir, 'docs'));
      const base = '# Docs\n\n- [A](A.md): a\n- [Z](Z.md): z\n';
      writeFileSync(join(dir, 'docs/README.md'), base);
      git('add', '-A'); git('commit', '-qm', 'base');
      git('checkout', '-qb', 'one');
      writeFileSync(join(dir, 'docs/README.md'), base.replace('- [Z]', '- [B](B.md): b\n- [Z]'));
      git('commit', '-qam', 'one');
      git('checkout', '-q', 'main'); git('checkout', '-qb', 'two');
      writeFileSync(join(dir, 'docs/README.md'), base.replace('- [Z]', '- [C](C.md): c\n- [Z]'));
      git('commit', '-qam', 'two');
      git('merge', '-q', '--no-edit', 'one');
      const merged = readFileSync(join(dir, 'docs/README.md'), 'utf8');
      expect(merged).toContain('[B](B.md)');
      expect(merged).toContain('[C](C.md)');
      expect(merged).not.toMatch(/^(<<<<<<<|=======|>>>>>>>)/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
