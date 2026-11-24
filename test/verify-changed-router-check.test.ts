import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  contribRouterProgramFiles,
  parserPackagePreflight,
  runContribRouterTypecheck,
  selectChangedFiles,
} from '../scripts/verify-changed.mjs';

const repoRoot = process.cwd();

describe('selectChangedFiles contrib router coverage', () => {
  it('triggers on router program scripts, the src boundary and shared manifests', () => {
    for (const path of [
      'contrib/router/policy.ts', 'contrib/router/supervisor.test.ts',
      'contrib/router/lib/deep/nested.ts', 'contrib/router/gone.ts',
      'src/core/authority/protected-paths.ts',
      'package.json', 'package-lock.json',
    ]) {
      expect(selectChangedFiles([path], [path]).contribRouterTypecheck).toBe(true);
    }
  });

  it('skips unrelated paths, near misses and non-program router files', () => {
    for (const path of [
      'contrib/router/README.md', 'contrib/router/config.example.json',
      'contrib/router/lib/router_io.cjs', 'contrib/router/ashlr-router',
      'contrib/routerish/policy.ts', 'contrib/mac/policy.ts',
      'src/core/authority/other.ts', 'src/core/x.ts',
    ]) {
      expect(selectChangedFiles([path], [path]).contribRouterTypecheck).toBe(false);
    }
  });

  it('still triggers on a deleted router program file', () => {
    expect(selectChangedFiles(['contrib/router/gone.ts'], []).contribRouterTypecheck).toBe(true);
  });
});

describe('contribRouterProgramFiles', () => {
  it('enumerates top-level *.ts files sorted, skipping non-scripts and subdirectories', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-router-files-'));
    try {
      mkdirSync(join(root, 'contrib/router/lib'), { recursive: true });
      writeFileSync(join(root, 'contrib/router/b.ts'), '');
      writeFileSync(join(root, 'contrib/router/a.ts'), '');
      writeFileSync(join(root, 'contrib/router/c.test.ts'), '');
      writeFileSync(join(root, 'contrib/router/lib/nested.ts'), '');
      writeFileSync(join(root, 'contrib/router/README.md'), '');
      writeFileSync(join(root, 'contrib/router/data.json'), '');
      expect(contribRouterProgramFiles(root)).toEqual([
        'contrib/router/a.ts',
        'contrib/router/b.ts',
        'contrib/router/c.test.ts',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns an empty list when the tree is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-router-empty-'));
    try {
      expect(contribRouterProgramFiles(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('runContribRouterTypecheck', () => {
  it('hands the whole program to one tsc run with the documented flags', () => {
    const calls: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
    const spawn = (cmd: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({ cmd, args, opts });
      return { status: 0, stdout: '', stderr: '' };
    };
    expect(runContribRouterTypecheck('/repo', ['contrib/router/a.ts', 'contrib/router/b.ts'], spawn as never)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe(process.execPath);
    expect(calls[0]!.args).toEqual([
      '--max-old-space-size=4096',
      'node_modules/typescript/bin/tsc',
      '--noEmit', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
      '--target', 'ES2022', '--strict', '--skipLibCheck',
      'contrib/router/a.ts', 'contrib/router/b.ts',
    ]);
    expect(calls[0]!.opts.cwd).toBe('/repo');
  });

  it('returns false and reports FAIL on a non-zero tsc result', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const spawn = () => ({ status: 1, stdout: '', stderr: 'contrib/router/bad.ts(1,7): error TS2322: Type string is not assignable to type number.', error: undefined, signal: null });
      expect(runContribRouterTypecheck('/repo', ['contrib/router/bad.ts'], spawn as never)).toBe(false);
    } finally {
      errors.mockRestore();
    }
  });

  it('returns false when tsc cannot be spawned', () => {
    const spawn = () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT'), signal: null });
    expect(runContribRouterTypecheck('/repo', ['contrib/router/a.ts'], spawn as never)).toBe(false);
  });

  it('type-checks the real contrib/router program and rejects a real type error when typescript exists', () => {
    if (!parserPackagePreflight(repoRoot, 'typescript').ok) return;
    const files = contribRouterProgramFiles(repoRoot);
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain('contrib/router/policy.ts');
    expect(runContribRouterTypecheck(repoRoot, files)).toBe(true);
    const root = mkdtempSync(join(tmpdir(), 'verify-router-bad-'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bad = join(root, 'bad.ts');
      writeFileSync(bad, 'const answer: number = "not a number";\n');
      expect(runContribRouterTypecheck(repoRoot, [bad])).toBe(false);
    } finally {
      errors.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  }, 120000);
});
