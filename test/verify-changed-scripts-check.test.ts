import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  parserPackagePreflight,
  runScriptsTypecheck,
  scriptsProgramFiles,
  selectChangedFiles,
} from '../scripts/verify-changed.mjs';

const repoRoot = process.cwd();

describe('selectChangedFiles scripts coverage', () => {
  it('triggers on every scripts .ts-family file, backend src paths and shared manifests', () => {
    for (const path of [
      'scripts/tier1-why.ts', 'scripts/evaluators/preparation-verification-workflow.ts',
      'scripts/lib/docs-pages.d.mts', 'scripts/deep/nested/tool.mts',
      'scripts/gone.ts',
      'src/core/fleet/x.ts', 'src/cli/y.ts', 'src/core/authority/protected-paths.ts',
      'package.json', 'package-lock.json',
    ]) {
      expect(selectChangedFiles([path], [path]).scriptsTypecheck).toBe(true);
    }
  });

  it('skips unrelated paths, near misses and non-TypeScript scripts files', () => {
    for (const path of [
      'scripts/check-realio-lane-membership.mjs', 'scripts/install.ps1',
      'scripts/data.json', 'scripts/README.md',
      'src/web-ui/view.tsx', 'src/raycast/ext.ts',
      'test/x.test.ts', 'docs/guide.md', 'contrib/router/policy.ts',
      'scripts-other/x.ts', 'tsconfig.json',
    ]) {
      expect(selectChangedFiles([path], [path]).scriptsTypecheck).toBe(false);
    }
  });

  it('still triggers on a deleted scripts TypeScript file or backend src file', () => {
    expect(selectChangedFiles(['scripts/gone.ts'], []).scriptsTypecheck).toBe(true);
    expect(selectChangedFiles(['src/core/gone.ts'], []).scriptsTypecheck).toBe(true);
  });
});

describe('scriptsProgramFiles', () => {
  it('walks scripts/ recursively for .ts-family files, sorted, pruning node_modules', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-scripts-files-'));
    try {
      mkdirSync(join(root, 'scripts/evaluators'), { recursive: true });
      mkdirSync(join(root, 'scripts/node_modules/dep'), { recursive: true });
      writeFileSync(join(root, 'scripts/b.ts'), '');
      writeFileSync(join(root, 'scripts/a.ts'), '');
      writeFileSync(join(root, 'scripts/evaluators/workflow.ts'), '');
      writeFileSync(join(root, 'scripts/types.d.mts'), '');
      writeFileSync(join(root, 'scripts/run.mjs'), '');
      writeFileSync(join(root, 'scripts/node_modules/dep/index.d.ts'), '');
      expect(scriptsProgramFiles(root)).toEqual([
        'scripts/a.ts',
        'scripts/b.ts',
        'scripts/evaluators/workflow.ts',
        'scripts/types.d.mts',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns an empty list when the tree is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-scripts-empty-'));
    try {
      expect(scriptsProgramFiles(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('runScriptsTypecheck', () => {
  it('hands the whole program to one tsc run with the documented flags', () => {
    const calls: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
    const spawn = (cmd: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({ cmd, args, opts });
      return { status: 0, stdout: '', stderr: '' };
    };
    expect(runScriptsTypecheck('/repo', ['scripts/a.ts', 'scripts/evaluators/b.ts'], spawn as never)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe(process.execPath);
    expect(calls[0]!.args).toEqual([
      '--max-old-space-size=4096',
      'node_modules/typescript/bin/tsc',
      '--noEmit', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
      '--target', 'ES2022', '--strict', '--skipLibCheck',
      'scripts/a.ts', 'scripts/evaluators/b.ts',
    ]);
    expect(calls[0]!.opts.cwd).toBe('/repo');
  });

  it('returns false and reports FAIL on a non-zero tsc result', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const spawn = () => ({ status: 1, stdout: '', stderr: 'scripts/bad.ts(1,7): error TS2322: Type string is not assignable to type number.', error: undefined, signal: null });
      expect(runScriptsTypecheck('/repo', ['scripts/bad.ts'], spawn as never)).toBe(false);
    } finally {
      errors.mockRestore();
    }
  });

  it('returns false when tsc cannot be spawned', () => {
    const spawn = () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT'), signal: null });
    expect(runScriptsTypecheck('/repo', ['scripts/a.ts'], spawn as never)).toBe(false);
  });

  it('type-checks the real scripts program and rejects a real type error when typescript exists', () => {
    if (!parserPackagePreflight(repoRoot, 'typescript').ok) return;
    const files = scriptsProgramFiles(repoRoot);
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain('scripts/tier1-why.ts');
    expect(files).toContain('scripts/evaluators/preparation-verification-workflow.ts');
    expect(files).toContain('scripts/lib/docs-pages.d.mts');
    expect(runScriptsTypecheck(repoRoot, files)).toBe(true);
    const root = mkdtempSync(join(tmpdir(), 'verify-scripts-bad-'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bad = join(root, 'bad.ts');
      writeFileSync(bad, 'const answer: number = "not a number";\n');
      expect(runScriptsTypecheck(repoRoot, [bad])).toBe(false);
    } finally {
      errors.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  }, 120000);
});
