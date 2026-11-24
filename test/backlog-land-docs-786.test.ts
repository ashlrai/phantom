import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const guide = readFileSync(resolve(root, 'CONTRIBUTING.md'), 'utf8');
const commands = guide.split('## Everyday commands\n')[1]?.split('\n## ')[0] ?? '';
const scripts = (JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
}).scripts;

function row(command: string): string {
  const matches = commands.split('\n').filter(line => line.startsWith(`| \`${command}\` |`));
  expect(matches, command).toHaveLength(1);
  return matches[0]!;
}

describe('preserved contributor command guidance (#7518)', () => {
  it('keeps all six source commands discoverable and backed by package scripts', () => {
    for (const name of ['typecheck:fast', 'gate', 'gate:full', 'check:quarantine', 'authority:regen', 'install:worktree']) {
      row(`npm run ${name}`);
      expect(scripts[name], name).toBeTruthy();
    }
    expect(scripts['gate:full']).toContain('--full');
    expect(row('npm run gate:full')).toContain('complete backend and web suites');
    const gate = row('npm run gate');
    for (const phrase of ['merge-base', 'origin/master', '-- --base <ref>', '-- --json', 'never pushes or contacts model providers']) {
      expect(gate).toContain(phrase);
    }
  });

  it('documents quarantine refusal and authority review without losing local navigation', () => {
    const quarantine = row('npm run check:quarantine');
    expect(quarantine).toContain('-- --base origin/master');
    expect(quarantine).toContain('refuse an added `.only`');
    const authority = row('npm run authority:regen');
    expect(authority).toContain('list each new Tier-1 root in the pull request body');
    for (const path of ['queue/quarantine.tsv', '.github/CODEOWNERS', 'test/fixtures/authority/tier1-closure.json']) {
      expect(existsSync(resolve(root, path)), path).toBe(true);
    }
    for (const match of commands.matchAll(/\]\(#([^)]+)\)/g)) {
      const headings = [...guide.matchAll(/^#{1,6} (.+)$/gm)].map(heading =>
        heading[1]!.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-'));
      expect(headings).toContain(match[1]);
    }
    expect(readFileSync(resolve(root, 'llms.txt'), 'utf8')).toMatch(/^# Phantom/);
  });
});
