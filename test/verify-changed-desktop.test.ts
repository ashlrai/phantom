import { describe, expect, it, vi } from 'vitest';
import {
  desktopSuiteInputs,
  desktopSuitePreflight,
  runDesktopSuite,
  runDesktopTypecheck,
  typecheckArgs,
  typecheckProjects,
} from '../scripts/verify-changed.mjs';

const repoRoot = process.cwd();

describe('typecheckProjects desktop selection', () => {
  it('selects the desktop project for desktop sources, backend src and shared manifests', () => {
    expect(typecheckProjects(['desktop/fleet-map/fleet-node-map.ts']).desktop).toBe(true);
    expect(typecheckProjects(['desktop/vitest.config.mts']).desktop).toBe(true);
    expect(typecheckProjects(['desktop/outcome-learning-view.ts']).desktop).toBe(true);
    expect(typecheckProjects(['desktop/src-tauri/src/main.rs']).desktop).toBe(true);
    expect(typecheckProjects(['src/core/graph/registry.ts']).desktop).toBe(true);
    expect(typecheckProjects(['src/core/routing/outcome-learning.ts']).desktop).toBe(true);
    expect(typecheckProjects(['src/web-ui/tsconfig.json']).desktop).toBe(true);
    expect(typecheckProjects(['package.json']).desktop).toBe(true);
    expect(typecheckProjects(['package-lock.json']).desktop).toBe(true);
  });

  it('skips the desktop project for web-ui sources, raycast, non-core src, tests and docs', () => {
    expect(typecheckProjects(['src/web-ui/app/App.tsx']).desktop).toBe(false);
    expect(typecheckProjects(['src/raycast/src/pulse.tsx']).desktop).toBe(false);
    expect(typecheckProjects(['src/cli/dispatch.ts']).desktop).toBe(false);
    expect(typecheckProjects(['test/verify-changed-desktop.test.ts']).desktop).toBe(false);
    expect(typecheckProjects(['docs/QUEUE.md']).desktop).toBe(false);
    expect(typecheckProjects(['scripts/verify-changed.mjs']).desktop).toBe(false);
  });
});

describe('typecheckArgs desktop project', () => {
  it('keeps a dedicated incremental cache separate from backend and web', () => {
    expect(typecheckArgs('/repo', 'desktop/tsconfig.json')).toEqual([
      '--noEmit', '-p', 'desktop/tsconfig.json', '--incremental',
      '--tsBuildInfoFile', '/repo/.ashlr-gate/verify/desktop.tsbuildinfo',
    ]);
    expect(typecheckArgs('/repo', 'src/web-ui/tsconfig.json').at(-1)).toBe('/repo/.ashlr-gate/verify/web.tsbuildinfo');
    expect(typecheckArgs('/repo').at(-1)).toBe('/repo/.ashlr-gate/verify/backend.tsbuildinfo');
  });
});

describe('runDesktopTypecheck', () => {
  it('uses tsgo when installed without invoking tsc', () => {
    const spawn = vi.fn(() => ({ status: 0 }));
    const run = vi.fn();
    expect(runDesktopTypecheck('/fixture', 60, run, spawn, () => true)).toBe(true);
    expect(spawn).toHaveBeenCalledWith('/fixture/node_modules/.bin/tsgo', [
      '--noEmit', '-p', 'desktop/tsconfig.json', '--incremental',
      '--tsBuildInfoFile', '/fixture/.ashlr-gate/verify/desktop.tsbuildinfo',
    ], expect.objectContaining({ timeout: 60_000 }));
    expect(run).not.toHaveBeenCalled();
  });

  it('uses tsc with the same timeout when tsgo is absent', () => {
    const spawn = vi.fn();
    const run = vi.fn(() => true);
    expect(runDesktopTypecheck('/fixture', 60, run, spawn, () => false)).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith('desktop typecheck', 'node_modules/typescript/bin/tsc', [
      '--noEmit', '-p', 'desktop/tsconfig.json', '--incremental',
      '--tsBuildInfoFile', '/fixture/.ashlr-gate/verify/desktop.tsbuildinfo',
    ], 60);
  });

  it.each([1, 2])('does not fall back on diagnostic exit %i', (status) => {
    const run = vi.fn();
    expect(runDesktopTypecheck('/fixture', 60, run, () => ({ status }), () => true)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('desktopSuiteInputs', () => {
  it('triggers on desktop TypeScript, the graph registry and manifests — including deletions', () => {
    expect(desktopSuiteInputs(['desktop/fleet-map/fleet-node-map.ts'])).toBe(true);
    expect(desktopSuiteInputs(['desktop/fleet-map/gone.ts'])).toBe(true);
    expect(desktopSuiteInputs(['desktop/vitest.config.mts'])).toBe(true);
    expect(desktopSuiteInputs(['src/core/graph/registry.ts'])).toBe(true);
    expect(desktopSuiteInputs(['src/core/graph/deleted.ts'])).toBe(true);
    expect(desktopSuiteInputs(['package.json'])).toBe(true);
    expect(desktopSuiteInputs(['package-lock.json'])).toBe(true);
  });

  it('skips unrelated changes, non-TypeScript desktop files and web-ui sources', () => {
    expect(desktopSuiteInputs(['docs/QUEUE.md'])).toBe(false);
    expect(desktopSuiteInputs(['src/core/cli.ts'])).toBe(false);
    expect(desktopSuiteInputs(['src/web-ui/app/App.tsx'])).toBe(false);
    expect(desktopSuiteInputs(['desktop/README.md'])).toBe(false);
    expect(desktopSuiteInputs(['desktop/src-tauri/src/main.rs'])).toBe(false);
    expect(desktopSuiteInputs(['desktop/fleet-map/index.html'])).toBe(false);
    expect(desktopSuiteInputs([])).toBe(false);
  });
});

describe('desktopSuitePreflight', () => {
  it('requires the vitest entry and the jsdom package', () => {
    const all = () => true;
    expect(desktopSuitePreflight('/fixture', all)).toEqual({ ok: true });
    expect(desktopSuitePreflight('/fixture', (path: string) => !path.endsWith('vitest.mjs'))).toEqual({
      ok: false, reason: 'node_modules/vitest/vitest.mjs is absent; run npm ci to restore it',
    });
    expect(desktopSuitePreflight('/fixture', (path: string) => !path.endsWith('jsdom/package.json'))).toEqual({
      ok: false, reason: 'node_modules/jsdom/package.json is absent; run npm ci to restore it',
    });
  });
});

describe('runDesktopSuite', () => {
  it('hands the run to one node vitest invocation against the desktop config', () => {
    const calls: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
    const spawn = (cmd: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({ cmd, args, opts });
      return { status: 0, stdout: 'Tests  3 passed', stderr: '' };
    };
    expect(runDesktopSuite('/repo', spawn as never)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe(process.execPath);
    expect(calls[0]!.args).toEqual(['node_modules/vitest/vitest.mjs', 'run', '--config', 'desktop/vitest.config.mts']);
    expect(calls[0]!.opts.cwd).toBe('/repo');
  });

  it('returns false and reports FAIL on a non-zero child result or spawn error', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(runDesktopSuite('/repo', (() => ({ status: 1, stdout: '', stderr: 'FAIL fleet-node-map' })) as never)).toBe(false);
      expect(runDesktopSuite('/repo', (() => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT') })) as never)).toBe(false);
      expect(logs).toHaveBeenCalledWith('FAIL desktop vitest suite');
    } finally {
      errors.mockRestore();
      logs.mockRestore();
    }
  });

  it('runs the real desktop suite green when the toolchain is installed', () => {
    if (!desktopSuitePreflight(repoRoot).ok) return;
    expect(runDesktopSuite(repoRoot)).toBe(true);
  });
});
