import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  parserPackagePreflight,
  runTestTypecheck,
  selectChangedFiles,
} from '../scripts/verify-changed.mjs';

const repoRoot = process.cwd();

describe('selectChangedFiles test coverage', () => {
  it('collects every existing .ts-family file under test/', () => {
    for (const path of [
      'test/foo.test.ts', 'test/helpers/h1-fixture.ts', 'test/setup/home.ts',
      'test/fixtures/eval/routing.ts', 'test/order-execution-join-390.test.tsx',
      'test/perf/server-bench.mts', 'test/untyped-js-imports.d.ts',
    ]) {
      expect(selectChangedFiles([path], [path]).testTypecheckFiles).toEqual([path]);
    }
  });

  it('skips non-TypeScript test files, other trees and near-miss prefixes', () => {
    for (const path of [
      'test/foo.test.js', 'test/README.md', 'test/config/realio-lane-membership.mjs',
      'src/core/x.ts', 'scripts/x.ts', 'contrib/router/x.ts', 'docs/x.md',
      'contest/x.ts', 'testing/x.ts', 'test',
    ]) {
      expect(selectChangedFiles([path], [path]).testTypecheckFiles).toEqual([]);
    }
  });

  it('drops deleted test files — there is no file left to check', () => {
    expect(selectChangedFiles(['test/gone.test.ts'], []).testTypecheckFiles).toEqual([]);
    expect(selectChangedFiles(['test/gone.test.ts', 'test/live.test.ts'], ['test/live.test.ts']).testTypecheckFiles)
      .toEqual(['test/live.test.ts']);
  });

  it('sorts and dedupes the file list for a deterministic tsc command line', () => {
    const selection = selectChangedFiles(
      ['test/b.test.ts', 'test/a.test.ts', 'test/b.test.ts'],
      ['test/a.test.ts', 'test/b.test.ts'],
    );
    expect(selection.testTypecheckFiles).toEqual(['test/a.test.ts', 'test/b.test.ts']);
  });
});

describe('runTestTypecheck', () => {
  it('runs one tsc file-list check with the shared flags plus interop, jsx and the shim root', () => {
    const calls: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
    const spawn = (cmd: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({ cmd, args, opts });
      return { status: 0, stdout: '', stderr: '' };
    };
    expect(runTestTypecheck('/repo', ['test/b.test.ts', 'test/a.test.ts'], spawn as never)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual([
      '--max-old-space-size=4096',
      'node_modules/typescript/bin/tsc',
      '--noEmit', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
      '--target', 'ES2022', '--strict', '--skipLibCheck', '--esModuleInterop',
      '--jsx', 'react-jsx',
      'test/untyped-js-imports.d.ts', 'test/b.test.ts', 'test/a.test.ts',
    ]);
    expect(calls[0]!.opts.cwd).toBe('/repo');
  });

  it('passes when tsc reports diagnostics only in unchanged files', () => {
    const logs: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => { logs.push(String(msg)); });
    try {
      const spawn = () => ({
        status: 1, error: undefined, signal: null,
        stdout: [
          'test/helpers/stale.ts(3,1): error TS2322: Type string is not assignable to type number.',
          'src/core/unchanged.ts(9,9): error TS2304: Cannot find name \'missing\'.',
        ].join('\n'),
        stderr: '',
      });
      expect(runTestTypecheck('/repo', ['test/a.test.ts'], spawn as never)).toBe(true);
      expect(logs.some((line) => line.includes('WARN test typecheck'))).toBe(true);
      expect(logs.some((line) => line.includes('2 pre-existing diagnostic(s)'))).toBe(true);
      expect(logs.at(-1)).toBe('PASS test typecheck');
    } finally {
      log.mockRestore();
    }
  });

  it('fails and prints only the changed-file diagnostics when tsc reports errors in them', () => {
    const logs: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => { logs.push(String(msg)); });
    try {
      const spawn = () => ({
        status: 1, error: undefined, signal: null,
        stdout: [
          'test/helpers/stale.ts(3,1): error TS2322: Type string is not assignable to type number.',
          'test/a.test.ts(7,2): error TS2339: Property \'nope\' does not exist on type \'Foo\'.',
        ].join('\n'),
        stderr: '',
      });
      expect(runTestTypecheck('/repo', ['test/a.test.ts'], spawn as never)).toBe(false);
      expect(logs).toContain("test/a.test.ts(7,2): error TS2339: Property 'nope' does not exist on type 'Foo'.");
      expect(logs.some((line) => line.includes('test/helpers/stale.ts(3,1)'))).toBe(false);
      expect(logs.at(-1)).toBe('FAIL test typecheck');
    } finally {
      log.mockRestore();
    }
  });

  it('fails on a non-zero tsc result with no parseable diagnostics', () => {
    const spawn = () => ({
      status: 1, error: undefined, signal: null,
      stdout: "error TS5023: Unknown compiler option '--bogus'.",
      stderr: '',
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(runTestTypecheck('/repo', ['test/a.test.ts'], spawn as never)).toBe(false);
    } finally {
      errors.mockRestore();
    }
  });

  it('returns false when tsc cannot be spawned or is killed', () => {
    const spawn = () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT'), signal: null });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(runTestTypecheck('/repo', ['test/a.test.ts'], spawn as never)).toBe(false);
    } finally {
      errors.mockRestore();
    }
  });

  it('type-checks a real clean suite file and rejects a real type error when typescript exists', () => {
    if (!parserPackagePreflight(repoRoot, 'typescript').ok) return;
    // A suite with no recorded type errors: the check must pass it.
    expect(runTestTypecheck(repoRoot, ['test/router-community-seats.test.ts'])).toBe(true);
    const root = mkdtempSync(join(tmpdir(), 'verify-test-bad-'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bad = join(root, 'bad.test.ts');
      writeFileSync(bad, 'const answer: number = "not a number";\n');
      expect(runTestTypecheck(repoRoot, [bad])).toBe(false);
    } finally {
      errors.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  }, 180000);
});
