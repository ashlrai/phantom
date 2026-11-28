import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const paths = ['CONTRIBUTING.md', 'docs/CONTRIBUTE-WITH-AN-AGENT.md'];
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('PR #9699 contributor setup preservation', () => {
  it('keeps GitHub sign-in, fork creation and SSH guidance in the existing guides', () => {
    for (const path of paths) {
      expect(existsSync(resolve(root, path)), path).toBe(true);
      const doc = read(path);
      for (const command of ['gh auth login', 'gh auth setup-git', 'gh repo fork ashlrai/phantom --clone=false']) {
        expect(doc, path).toContain(command);
      }
      expect(doc, path).toContain('origin/master');
      expect(doc, path).toContain('npm run install:worktree');
    }
    const guide = read(paths[1]);
    expect(guide).toContain('a person runs it once');
    expect(guide).toContain('git@github.com:<you>/phantom.git');
    expect(guide).toContain('GitHub CLI (`gh`)');
    // Retain the newer master explanation while carrying the original setup text.
    expect(read(paths[0])).toContain('JSONC-tolerant');
    expect(read('llms.txt').startsWith('# Phantom')).toBe(true);
  });

  it('resolves every named Phantom command to the master CLI and checks publish verbs', () => {
    const entry = read('src/cli/index.ts');
    const registry = read('src/cli/help.ts');
    expect(read(paths[0])).toContain('phm --help');
    expect(entry).toContain("case '--help':");
    expect(existsSync(resolve(root, 'src/cli/help.ts'))).toBe(true);
    const commands = new Set<string>();
    for (const path of paths) {
      const doc = read(path);
      for (const match of doc.matchAll(/(?<![\w/])(?:phm|ashlr)[ \t]+([a-z][a-z0-9-]*)(?:[ \t]+([a-z][a-z0-9-]*))?/g)) {
        const [, command, verb] = match;
        commands.add(command);
        const sourcePath = `src/cli/${command}.ts`;
        expect(existsSync(resolve(root, sourcePath)), `${path}: ${command}`).toBe(true);
        expect(entry, `${command} must be dispatched`).toContain(`case '${command}':`);
        if (command === 'publish') {
          expect(registry, `${path}: publish ${verb}`).toContain(`phm publish ${verb}`);
          expect(read(sourcePath)).toContain(verb);
        }
      }
    }
    expect([...commands].sort()).toEqual(['publish', 'verify-safety']);
  });
});
