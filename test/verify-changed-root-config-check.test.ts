import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  parserPackagePreflight,
  rootConfigProgramFiles,
  runRootConfigTypecheck,
  selectChangedFiles,
} from '../scripts/verify-changed.mjs';

const repoRoot = process.cwd();

describe('selectChangedFiles root config coverage', () => {
  it('triggers on root-level .ts-family files, test/config .ts-family files and shared manifests', () => {
    for (const path of [
      'vitest.config.ts', 'vite.config.web.ts', 'vitest.config.new-lane.mts',
      'vitest.config.d.cts', 'root-tool.ts', 'root-tool.gone.ts',
      'test/config/realio-lane-membership.d.mts', 'test/config/weighted-sequencer.d.mts',
      'test/config/nested/helper.d.ts', 'test/config/gone.d.mts',
      'package.json', 'package-lock.json',
    ]) {
      expect(selectChangedFiles([path], [path]).rootConfigTypecheck).toBe(true);
    }
  });

  it('skips nested paths, near misses and non-TypeScript root configs', () => {
    for (const path of [
      'src/vitest.config.ts', 'scripts/vitest.config.ts', 'docs/vitest.config.ts',
      'test/vitest.config.ts', 'test/config/realio-lane-membership.mjs',
      'eslint.config.js', 'vitest.config.coverage.mjs', 'tsconfig.json',
      'test/other/file.d.mts', 'test/config-data/x.d.mts',
    ]) {
      expect(selectChangedFiles([path], [path]).rootConfigTypecheck).toBe(false);
    }
  });

  it('still triggers on a deleted root config or test/config declaration file', () => {
    expect(selectChangedFiles(['vitest.config.ts'], []).rootConfigTypecheck).toBe(true);
    expect(selectChangedFiles(['test/config/realio-lane-membership.d.mts'], []).rootConfigTypecheck).toBe(true);
  });
});

describe('rootConfigProgramFiles', () => {
  it('collects root-level .ts-family files plus test/config .ts-family files, sorted, pruning node_modules', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-root-config-files-'));
    try {
      mkdirSync(join(root, 'test/config/nested'), { recursive: true });
      mkdirSync(join(root, 'test/config/node_modules/dep'), { recursive: true });
      writeFileSync(join(root, 'vitest.config.ts'), '');
      writeFileSync(join(root, 'vite.config.web.ts'), '');
      writeFileSync(join(root, 'vitest.config.coverage.mjs'), '');
      writeFileSync(join(root, 'eslint.config.js'), '');
      writeFileSync(join(root, 'tsconfig.json'), '{}');
      writeFileSync(join(root, 'src-root.ts'), '');
      writeFileSync(join(root, 'test/config/realio-lane-membership.d.mts'), '');
      writeFileSync(join(root, 'test/config/nested/helper.d.ts'), '');
      writeFileSync(join(root, 'test/config/lane.mjs'), '');
      writeFileSync(join(root, 'test/config/node_modules/dep/index.d.ts'), '');
      expect(rootConfigProgramFiles(root)).toEqual([
        'src-root.ts',
        'test/config/nested/helper.d.ts',
        'test/config/realio-lane-membership.d.mts',
        'vite.config.web.ts',
        'vitest.config.ts',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns an empty list when neither root set exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-root-config-empty-'));
    try {
      expect(rootConfigProgramFiles(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('runRootConfigTypecheck', () => {
  it('hands the whole program to one tsc run with the documented flags', () => {
    const calls: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
    const spawn = (cmd: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({ cmd, args, opts });
      return { status: 0, stdout: '', stderr: '' };
    };
    expect(runRootConfigTypecheck('/repo', ['vitest.config.ts', 'test/config/x.d.mts'], spawn as never)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe(process.execPath);
    expect(calls[0]!.args).toEqual([
      '--max-old-space-size=4096',
      'node_modules/typescript/bin/tsc',
      '--noEmit', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
      '--target', 'ES2022', '--strict', '--skipLibCheck',
      'vitest.config.ts', 'test/config/x.d.mts',
    ]);
    expect(calls[0]!.opts.cwd).toBe('/repo');
  });

  it('returns false and reports FAIL on a non-zero tsc result', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const spawn = () => ({ status: 1, stdout: '', stderr: 'vitest.config.ts(1,7): error TS2322: Type string is not assignable to type number.', error: undefined, signal: null });
      expect(runRootConfigTypecheck('/repo', ['vitest.config.ts'], spawn as never)).toBe(false);
    } finally {
      errors.mockRestore();
    }
  });

  it('returns false when tsc cannot be spawned', () => {
    const spawn = () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT'), signal: null });
    expect(runRootConfigTypecheck('/repo', ['vitest.config.ts'], spawn as never)).toBe(false);
  });

  it('type-checks the real root config program and rejects a real type error when typescript exists', () => {
    if (!parserPackagePreflight(repoRoot, 'typescript').ok) return;
    const files = rootConfigProgramFiles(repoRoot);
    expect(files).toContain('vitest.config.ts');
    expect(files).toContain('vite.config.web.ts');
    expect(files).toContain('vitest.config.web.ts');
    expect(files).toContain('test/config/realio-lane-membership.d.mts');
    expect(files).toContain('test/config/serial-cpu-lane-membership.d.mts');
    expect(files).toContain('test/config/weighted-sequencer.d.mts');
    expect(files).not.toContain('vitest.config.coverage.mjs');
    expect(files).not.toContain('eslint.config.js');
    expect(runRootConfigTypecheck(repoRoot, files)).toBe(true);
    const root = mkdtempSync(join(tmpdir(), 'verify-root-config-bad-'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bad = join(root, 'bad.ts');
      writeFileSync(bad, 'const answer: number = "not a number";\n');
      expect(runRootConfigTypecheck(repoRoot, [bad])).toBe(false);
    } finally {
      errors.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  }, 120000);
});
