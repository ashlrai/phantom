import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

const COMPILERS = new Set(['tsc', 'tsgo']);
const DEFAULT_PROJECT = 'tsconfig.json';

/**
 * The tsconfig projects one npm script typechecks. A script is a chain of
 * commands (`a && b`); each command that invokes tsc/tsgo contributes the
 * project from its `-p`/`--project` flag, or the default `tsconfig.json` when
 * the flag is absent. `npm run <name>` segments recurse so indirection through
 * scripts like `typecheck:web` still names the real project.
 */
function scriptProjects(script: string, seen: ReadonlySet<string> = new Set()): Set<string> {
  const projects = new Set<string>();
  for (const command of script.split(/&&|\|\||;/)) {
    const tokens = command.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    if (tokens[0] === 'npx' || tokens[0] === 'npm-exec') tokens.shift();
    const nameIndex = tokens.findIndex((token) => COMPILERS.has(token));
    if (tokens[0] === 'npm' && tokens[1] === 'run') {
      const target = tokens.slice(2).find((token) => !token.startsWith('-'));
      if (target && pkg.scripts[target] && !seen.has(target)) {
        for (const project of scriptProjects(pkg.scripts[target], new Set([...seen, target]))) {
          projects.add(project);
        }
      }
      continue;
    }
    if (nameIndex === -1) continue;
    const args = tokens.slice(nameIndex + 1);
    const flagIndex = args.findIndex((token) => token === '-p' || token === '--project');
    if (flagIndex !== -1 && args[flagIndex + 1] && !args[flagIndex + 1].startsWith('-')) {
      projects.add(args[flagIndex + 1]);
      continue;
    }
    const inline = args.find((token) => token.startsWith('-p=') || token.startsWith('--project='));
    projects.add(inline ? inline.slice(inline.indexOf('=') + 1) : DEFAULT_PROJECT);
  }
  return projects;
}

describe('typecheck:fast project parity', () => {
  it('names the same tsconfig projects as typecheck', () => {
    expect(pkg.scripts['typecheck']).toBeTypeOf('string');
    expect(pkg.scripts['typecheck:fast']).toBeTypeOf('string');
    expect([...scriptProjects(pkg.scripts['typecheck:fast'])].sort()).toEqual(
      [...scriptProjects(pkg.scripts['typecheck'])].sort(),
    );
  });

  it('every named project file exists', () => {
    for (const script of ['typecheck', 'typecheck:fast']) {
      for (const project of scriptProjects(pkg.scripts[script])) {
        expect(existsSync(join(repoRoot, project)), `${script}: ${project}`).toBe(true);
      }
    }
  });
});
