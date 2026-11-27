import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  contribProgramFiles,
  contribRouterProgramFiles,
  contribSatelliteProgramFiles,
  parserPackagePreflight,
  runContribTypecheck,
  selectChangedFiles,
} from '../scripts/verify-changed.mjs';

const repoRoot = process.cwd();

describe('selectChangedFiles contrib coverage', () => {
  it('triggers on every contrib .ts-family file, the src boundary and shared manifests', () => {
    for (const path of [
      'contrib/router/policy.ts', 'contrib/router/supervisor.test.ts',
      'contrib/router/lib/deep/nested.ts', 'contrib/router/gone.ts',
      'contrib/mac/memguard/mac.ts', 'contrib/mac/memguard/rules.ts',
      'contrib/mac/new-guard.tsx', 'contrib/routerish/policy.ts',
      'src/core/authority/protected-paths.ts',
      'package.json', 'package-lock.json',
    ]) {
      expect(selectChangedFiles([path], [path]).contribTypecheck).toBe(true);
    }
  });

  it('skips unrelated paths, near misses and non-TypeScript contrib files', () => {
    for (const path of [
      'contrib/router/README.md', 'contrib/router/config.example.json',
      'contrib/router/lib/router_io.cjs', 'contrib/router/ashlr-router',
      'contrib/mac/dispatchd.py', 'contrib/mac/node-runner.mjs',
      'contrib/mac/com.ashlr.memguard.plist',
      'src/core/authority/other.ts', 'src/core/x.ts',
      'examples/agents/bus-reply-file.ts',
    ]) {
      expect(selectChangedFiles([path], [path]).contribTypecheck).toBe(false);
    }
  });

  it('still triggers on a deleted contrib TypeScript file', () => {
    expect(selectChangedFiles(['contrib/mac/memguard/gone.ts'], []).contribTypecheck).toBe(true);
    expect(selectChangedFiles(['contrib/router/gone.ts'], []).contribTypecheck).toBe(true);
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

describe('contribSatelliteProgramFiles', () => {
  it('walks contrib/ recursively for .ts-family files outside the router subtree', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-satellite-files-'));
    try {
      mkdirSync(join(root, 'contrib/mac/memguard'), { recursive: true });
      mkdirSync(join(root, 'contrib/router/lib'), { recursive: true });
      mkdirSync(join(root, 'contrib/mac/node_modules/dep'), { recursive: true });
      writeFileSync(join(root, 'contrib/mac/memguard/mac.ts'), '');
      writeFileSync(join(root, 'contrib/mac/memguard/rules.ts'), '');
      writeFileSync(join(root, 'contrib/mac/memguard/types.d.mts'), '');
      writeFileSync(join(root, 'contrib/mac/node-runner.mjs'), '');
      writeFileSync(join(root, 'contrib/mac/dispatchd.py'), '');
      // Router subtree is the other program boundary: every file under it is
      // excluded here, including nested .ts the router boundary also skips.
      writeFileSync(join(root, 'contrib/router/policy.ts'), '');
      writeFileSync(join(root, 'contrib/router/lib/nested.ts'), '');
      // Vendored trees are never program roots.
      writeFileSync(join(root, 'contrib/mac/node_modules/dep/index.d.ts'), '');
      expect(contribSatelliteProgramFiles(root)).toEqual([
        'contrib/mac/memguard/mac.ts',
        'contrib/mac/memguard/rules.ts',
        'contrib/mac/memguard/types.d.mts',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns an empty list when the tree is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-satellite-empty-'));
    try {
      expect(contribSatelliteProgramFiles(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('contribProgramFiles', () => {
  it('unions the router boundary and the satellites into one sorted program', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-contrib-program-'));
    try {
      mkdirSync(join(root, 'contrib/mac/memguard'), { recursive: true });
      mkdirSync(join(root, 'contrib/router/lib'), { recursive: true });
      writeFileSync(join(root, 'contrib/router/zeta.ts'), '');
      writeFileSync(join(root, 'contrib/router/alpha.ts'), '');
      writeFileSync(join(root, 'contrib/router/lib/nested.ts'), '');
      writeFileSync(join(root, 'contrib/mac/memguard/mac.ts'), '');
      writeFileSync(join(root, 'contrib/mac/memguard/rules.ts'), '');
      expect(contribProgramFiles(root)).toEqual([
        'contrib/mac/memguard/mac.ts',
        'contrib/mac/memguard/rules.ts',
        'contrib/router/alpha.ts',
        'contrib/router/zeta.ts',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('runContribTypecheck', () => {
  it('hands the whole program to one tsc run with the documented flags', () => {
    const calls: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
    const spawn = (cmd: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({ cmd, args, opts });
      return { status: 0, stdout: '', stderr: '' };
    };
    expect(runContribTypecheck('/repo', ['contrib/router/a.ts', 'contrib/mac/memguard/b.ts'], spawn as never)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe(process.execPath);
    expect(calls[0]!.args).toEqual([
      '--max-old-space-size=4096',
      'node_modules/typescript/bin/tsc',
      '--noEmit', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
      '--target', 'ES2022', '--strict', '--skipLibCheck',
      'contrib/router/a.ts', 'contrib/mac/memguard/b.ts',
    ]);
    expect(calls[0]!.opts.cwd).toBe('/repo');
  });

  it('returns false and reports FAIL on a non-zero tsc result', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const spawn = () => ({ status: 1, stdout: '', stderr: 'contrib/router/bad.ts(1,7): error TS2322: Type string is not assignable to type number.', error: undefined, signal: null });
      expect(runContribTypecheck('/repo', ['contrib/router/bad.ts'], spawn as never)).toBe(false);
    } finally {
      errors.mockRestore();
    }
  });

  it('returns false when tsc cannot be spawned', () => {
    const spawn = () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT'), signal: null });
    expect(runContribTypecheck('/repo', ['contrib/router/a.ts'], spawn as never)).toBe(false);
  });

  it('type-checks the real contrib program — router plus satellites — and rejects a real type error when typescript exists', () => {
    if (!parserPackagePreflight(repoRoot, 'typescript').ok) return;
    const files = contribProgramFiles(repoRoot);
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain('contrib/router/policy.ts');
    expect(files).toContain('contrib/mac/memguard/mac.ts');
    expect(runContribTypecheck(repoRoot, files)).toBe(true);
    const root = mkdtempSync(join(tmpdir(), 'verify-contrib-bad-'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bad = join(root, 'bad.ts');
      writeFileSync(bad, 'const answer: number = "not a number";\n');
      expect(runContribTypecheck(repoRoot, [bad])).toBe(false);
    } finally {
      errors.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  }, 120000);
});
