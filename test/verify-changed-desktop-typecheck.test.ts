import { describe, expect, it, vi } from 'vitest';
import { runDesktopTypecheck, runWebTypecheck, typecheckArgs, typecheckProjects } from '../scripts/verify-changed.mjs';

describe('desktop typecheck project selection', () => {
  it('selects desktop for desktop paths, its base config and shared manifests', () => {
    for (const path of [
      'desktop/fleet-map/fleet-node-map.ts', 'desktop/tsconfig.json', 'desktop/vitest.config.mts',
      'desktop/outcome-learning-view.ts', 'src/web-ui/tsconfig.json', 'package.json', 'package-lock.json',
    ]) {
      expect(typecheckProjects([path]).desktop, path).toBe(true);
    }
  });

  it('keeps desktop unselected for unrelated diffs', () => {
    for (const path of [
      'src/core/x.ts', 'src/web-ui/view.tsx', 'test/x.test.ts', 'scripts/x.mjs',
      'docs/guide.md', 'desktop-other/x.ts', 'desktop',
    ]) {
      expect(typecheckProjects([path]).desktop, path).toBe(false);
    }
    expect(typecheckProjects([]).desktop).toBe(false);
  });

  it('names a distinct incremental build-info file per project', () => {
    expect(typecheckArgs('/fixture', 'desktop/tsconfig.json').at(-1)).toBe('/fixture/.ashlr-gate/verify/desktop.tsbuildinfo');
    expect(typecheckArgs('/fixture', 'src/web-ui/tsconfig.json').at(-1)).toBe('/fixture/.ashlr-gate/verify/web.tsbuildinfo');
    expect(typecheckArgs('/fixture').at(-1)).toBe('/fixture/.ashlr-gate/verify/backend.tsbuildinfo');
  });
});

describe('desktop compiler selection', () => {
  it('uses tsgo when installed without invoking tsc', () => {
    const spawn = vi.fn(() => ({ status: 0 }));
    const run = vi.fn();
    expect(runDesktopTypecheck('/fixture', 60, run, spawn, () => true)).toBe(true);
    expect(spawn).toHaveBeenCalledWith('/fixture/node_modules/.bin/tsgo', ['--noEmit', '-p', 'desktop/tsconfig.json', '--incremental', '--tsBuildInfoFile', '/fixture/.ashlr-gate/verify/desktop.tsbuildinfo'], expect.objectContaining({ timeout: 60_000 }));
    expect(run).not.toHaveBeenCalled();
  });

  it('uses tsc with the same timeout when tsgo is absent', () => {
    const spawn = vi.fn();
    const run = vi.fn(() => true);
    expect(runDesktopTypecheck('/fixture', 60, run, spawn, () => false)).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith('desktop typecheck', 'node_modules/typescript/bin/tsc', ['--noEmit', '-p', 'desktop/tsconfig.json', '--incremental', '--tsBuildInfoFile', '/fixture/.ashlr-gate/verify/desktop.tsbuildinfo'], 60);
  });

  it.each([1, 2])('does not fall back on diagnostic exit %i', (status) => {
    const run = vi.fn();
    expect(runDesktopTypecheck('/fixture', 60, run, () => ({ status }), () => true)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('falls back after a crash but not a timeout', () => {
    const run = vi.fn(() => true);
    expect(runDesktopTypecheck('/fixture', 60, run, () => ({ status: 3 }), () => true)).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    expect(runDesktopTypecheck('/fixture', 60, run, () => ({ error: { code: 'ETIMEDOUT' } }), () => true)).toBe(false);
    expect(run).toHaveBeenCalledOnce();
  });

  it('shares the native-first policy with the web project', () => {
    const spawn = vi.fn(() => ({ status: 0 }));
    const run = vi.fn();
    expect(runWebTypecheck('/fixture', 60, run, spawn, () => true)).toBe(true);
    expect(runDesktopTypecheck('/fixture', 60, run, spawn, () => true)).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[1]?.[1]).toContain('desktop/tsconfig.json');
  });
});
