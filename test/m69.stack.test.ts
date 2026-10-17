/**
 * M69 — stack integration detection (read-only/advisory).
 *
 * Hermetic + portable: real integration wrapper and filesystem checks, with
 * synthetic child-process results. Never invokes an ambient CLI or provider.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { spawnSync } = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock('node:child_process', () => ({ spawnSync }));

import {
  stackConfiguredServices,
  stackInstalled,
  stackProjectConfigured,
  stackRun,
  stackRunInteractive,
  stackStatus,
} from '../src/core/integrations/stack.js';

function result(stdout = '', status: number | null = 0, error?: Error, stderr = ''): SpawnSyncReturns<string> {
  return { pid: 1, output: [], stdout, stderr, status, signal: null, error };
}

function withRepo<T>(toml: string | null, fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'ashlr-m69-'));
  try {
    if (toml !== null) writeFileSync(join(dir, '.stack.toml'), toml, 'utf8');
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const STACK_TOML = [
  '[stack]', 'version = "1"', '', '[services]', '[[environments]]', 'name = "dev"', '',
  '[services.supabase]', 'provider = "supabase"', 'secrets = ["SUPABASE_URL"]', '',
  '[services."open-ai"]  # quoted key', 'provider = "openai"', '',
].join('\n');

beforeEach(() => {
  spawnSync.mockReset().mockReturnValue(result('', 1));
});

describe('M69 — stack integration', () => {
  it('stackInstalled returns a boolean and never throws', () => {
    expect(stackInstalled()).toBe(false);
    expect(spawnSync).toHaveBeenCalledWith(process.platform === 'win32' ? 'where' : 'which', ['stack'], { stdio: 'ignore' });
    spawnSync.mockReturnValue(result());
    expect(stackInstalled()).toBe(true);
    spawnSync.mockImplementation(() => { throw new Error('unavailable probe'); });
    expect(stackInstalled()).toBe(false);
  });

  it('stackStatus never throws; ok:false with a detail when stack is absent', () => {
    expect(stackStatus()).toEqual({ ok: false, detail: 'stack not installed' });
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(spawnSync.mock.calls.some(([bin]) => bin === 'stack')).toBe(false);
  });

  it('reads only bounded status JSON and retains valid service names', () => {
    spawnSync.mockReturnValueOnce(result()).mockReturnValueOnce(result(JSON.stringify({
      services: ['github', { name: 'supabase' }, { name: 3 }, null, ''],
    })));
    expect(stackStatus('/synthetic/repo')).toEqual({ ok: true, services: ['github', 'supabase'], detail: '2 service(s)' });
    expect(spawnSync).toHaveBeenCalledTimes(2);
    expect(spawnSync).toHaveBeenLastCalledWith('stack', ['status', '--json'], expect.objectContaining({
      cwd: '/synthetic/repo', encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'],
    }));
  });

  it.each([
    { label: 'nonzero exit', status: 2, error: undefined, detail: 'stack status exit 2' },
    { label: 'timeout', status: null, error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), detail: 'stack status exit error' },
  ])('reports $label without throwing', ({ status, error, detail }) => {
    spawnSync.mockReturnValueOnce(result()).mockReturnValueOnce(result('', status, error));
    expect(stackStatus()).toEqual({ ok: false, detail });
    expect(spawnSync).toHaveBeenCalledTimes(2);
  });

  it('falls back to .stack.toml service tables when status is not JSON', () => {
    withRepo(STACK_TOML, (dir) => {
      spawnSync.mockReturnValueOnce(result()).mockReturnValueOnce(result('status ready'));
      expect(stackStatus(dir)).toEqual({
        ok: true,
        services: ['supabase', 'open-ai'],
        detail: '2 service(s) from .stack.toml (stack status not JSON-parseable)',
      });
    });
  });

  it('reports ok:false when status is not JSON and there is no .stack.toml', () => {
    withRepo(null, (dir) => {
      spawnSync.mockReturnValueOnce(result()).mockReturnValueOnce(result('status ready'));
      expect(stackStatus(dir)).toEqual({ ok: false, detail: 'stack status not JSON-parseable and no .stack.toml to read' });
    });
  });

  it('stackConfiguredServices reads table headers only and tolerates CRLF', () => {
    withRepo('[services]\r\n[services.neon]\r\nprovider = "neon"\r\n[servicesx.no]\r\n# [services.commented]\r\n', (dir) => {
      expect(stackConfiguredServices(dir)).toEqual(['neon']);
    });
    withRepo(null, (dir) => expect(stackConfiguredServices(dir)).toBeNull());
  });

  it('stackRun returns Stack stderr alongside stdout', () => {
    spawnSync.mockReturnValueOnce(result()).mockReturnValueOnce(result('', 1, undefined, 'stack: no TTY detected\n'));
    expect(stackRun(['scan'])).toEqual({ ok: false, stdout: '', stderr: 'stack: no TTY detected', code: 1 });
  });

  it('stackRunInteractive inherits stdio with a long bound and reports the exit code', () => {
    spawnSync.mockReturnValueOnce(result()).mockReturnValueOnce(result('', 0));
    expect(stackRunInteractive(['add', 'supabase'])).toEqual({ ok: true, code: 0 });
    expect(spawnSync).toHaveBeenLastCalledWith('stack', ['add', 'supabase'], expect.objectContaining({
      stdio: 'inherit', timeout: 600_000,
    }));
    spawnSync.mockReturnValueOnce(result()).mockReturnValueOnce(result('', null, Object.assign(new Error('t'), { code: 'ETIMEDOUT' })));
    expect(stackRunInteractive(['apply'])).toEqual({ ok: false, code: null });
    spawnSync.mockReturnValueOnce(result('', 1));
    expect(stackRunInteractive(['apply'])).toEqual({ ok: false, code: null });
  });

  it('reports a status launch exception without throwing', () => {
    spawnSync.mockReturnValueOnce(result()).mockImplementationOnce(() => { throw new Error('status launch failed'); });
    expect(stackStatus()).toEqual({ ok: false, detail: 'status launch failed' });
  });

  it('stackProjectConfigured detects .stack.toml presence/absence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ashlr-m69-'));
    try {
      expect(stackProjectConfigured(dir)).toBe(false);
      writeFileSync(join(dir, '.stack.toml'), '[stack]\n', 'utf8');
      expect(stackProjectConfigured(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
