import { afterEach, describe, expect, it, vi } from 'vitest';
import { eslintPreflight, runRealioCheck, runWebTypecheck } from '../scripts/verify-changed.mjs';

const missingOutput = `
[check-realio-lane-membership] The following test files use a real-io marker
but are not in REAL_IO_TEST_FILES (test/config/realio-lane-membership.mjs):

  test/changed.test.ts
    spawns a real child process
  test/other test.test.ts
    binds a real local network server
`;

afterEach(() => vi.restoreAllMocks());

describe('scoped real-io guard', () => {
  it('fails for a changed omission and warns about unchanged omissions', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const spawn = vi.fn(() => ({ status: 1, stderr: missingOutput }));
    expect(runRealioCheck('/fixture', ['test/changed.test.ts'], spawn)).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('test/changed.test.ts'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('test/other test.test.ts'));
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('warns and passes when all omissions are unchanged', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(runRealioCheck('/fixture', ['src/changed.ts'], () => ({ status: 1, stderr: missingOutput }))).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('test/changed.test.ts'));
  });

  it('scopes stale entries and ignores soft signals', () => {
    const stderr = `[check-realio-lane-membership] soft signal only
  test/soft.test.ts
[check-realio-lane-membership] stale KNOWN_FAST_SPAWN_FILES entries
  test/stale.test.ts
[check-realio-lane-membership] stale REAL_IO_TEST_FILES entries
  test/deleted.test.ts`;
    expect(runRealioCheck('/fixture', ['test/soft.test.ts'], () => ({ status: 1, stderr }))).toBe(true);
    expect(runRealioCheck('/fixture', ['test/deleted.test.ts'], () => ({ status: 1, stderr }))).toBe(false);
  });

  it('fails closed on an unrecognized error or a process failure', () => {
    expect(runRealioCheck('/fixture', [], () => ({ status: 1, stderr: 'unexpected error' }))).toBe(false);
    expect(runRealioCheck('/fixture', [], () => ({ status: null, error: { message: 'failed to start' } }))).toBe(false);
  });
});

describe('web compiler selection', () => {
  it('uses tsgo when installed without invoking tsc', () => {
    const spawn = vi.fn(() => ({ status: 0 }));
    const run = vi.fn();
    expect(runWebTypecheck('/fixture', 60, run, spawn, () => true)).toBe(true);
    expect(spawn).toHaveBeenCalledWith('/fixture/node_modules/.bin/tsgo', ['--noEmit', '-p', 'src/web-ui/tsconfig.json'], expect.objectContaining({ timeout: 60_000 }));
    expect(run).not.toHaveBeenCalled();
  });

  it('uses tsc with the same timeout when tsgo is absent', () => {
    const spawn = vi.fn();
    const run = vi.fn(() => true);
    expect(runWebTypecheck('/fixture', 60, run, spawn, () => false)).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith('web typecheck', 'node_modules/typescript/bin/tsc', ['--noEmit', '-p', 'src/web-ui/tsconfig.json'], 60);
  });

  it.each([1, 2])('does not fall back on diagnostic exit %i', (status) => {
    const run = vi.fn();
    expect(runWebTypecheck('/fixture', 60, run, () => ({ status }), () => true)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('falls back after a crash but not a timeout', () => {
    const run = vi.fn(() => true);
    expect(runWebTypecheck('/fixture', 60, run, () => ({ status: 3 }), () => true)).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    expect(runWebTypecheck('/fixture', 60, run, () => ({ error: { code: 'ETIMEDOUT' } }), () => true)).toBe(false);
    expect(run).toHaveBeenCalledOnce();
  });
});

describe('eslint preflight', () => {
  it('identifies an incomplete installation for the existing skip path', () => {
    expect(eslintPreflight('/fixture', (path: string) => path.endsWith('/bin/eslint.js'))).toEqual({
      ok: false, reason: 'node_modules/eslint/lib/cli.js is absent; run npm ci to restore it',
    });
  });
});
