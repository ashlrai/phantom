import { describe, expect, it, vi } from 'vitest';
import { runNativeTypecheck } from '../scripts/verify-changed.mjs';

describe('native backend compiler selection', () => {
  it('runs the installed binary with backend arguments', () => {
    const spawn = vi.fn(() => ({ status: 0 }));
    expect(runNativeTypecheck('/fixture', 60, spawn, () => true)).toBe(true);
    expect(spawn).toHaveBeenCalledWith('/fixture/node_modules/.bin/tsgo', ['--noEmit', '-p', 'tsconfig.json'], expect.objectContaining({ cwd: '/fixture' }));
  });
  it('falls back when the binary is missing', () => {
    const spawn = vi.fn();
    expect(runNativeTypecheck('/fixture', 60, spawn, () => false)).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });
  it.each([1, 2])('fails on diagnostic exit %i without fallback', (status) => {
    expect(runNativeTypecheck('/fixture', 60, () => ({ status }), () => true)).toBe(false);
  });
  it.each([{ status: 3 }, { status: null, signal: 'SIGABRT' }, { error: { code: 'ENOENT' } }])('falls back on internal crash %j', (result) => {
    expect(runNativeTypecheck('/fixture', 60, () => result, () => true)).toBeNull();
  });
  it('does not retry a timed out compiler', () => {
    expect(runNativeTypecheck('/fixture', 60, () => ({ error: { code: 'ETIMEDOUT' } }), () => true)).toBe(false);
  });
});
