import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const child = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  execFileSync: vi.fn(),
}));
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  spawnSync: child.spawnSync,
  execFileSync: child.execFileSync,
}));

import { listPrs } from '../src/core/integrations/github.js';
import { listDeploys } from '../src/core/integrations/vercel.js';

let root: string;
let phantom: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'phantom-credential-integration-'));
  phantom = join(root, process.platform === 'win32' ? 'phantom.exe' : 'phantom');
  writeFileSync(phantom, 'synthetic executable; all subprocess calls are mocked');
  chmodSync(phantom, 0o700);
  vi.stubEnv('PATH', root);
  child.execFileSync.mockImplementation((file: string, args: string[]) => {
    if ((file === 'which' || file === 'where') && args[0] === 'phantom') return phantom;
    throw new Error('Unexpected execution');
  });
  child.spawnSync.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function respond(stdout: string, status = 0): void {
  child.spawnSync.mockReturnValue({ pid: 1, output: [], stdout, stderr: '', status, signal: null });
}

describe('credential transport integration', () => {
  it('reads GitHub PRs through Secrets while preserving bounded noninteractive execution', () => {
    respond(JSON.stringify([{ number: 42, title: 'Fixture', url: 'https://github.com/example/repo/pull/42', state: 'OPEN', author: { login: 'fixture' } }]));
    expect(listPrs(root)).toMatchObject([{ number: 42, title: 'Fixture' }]);
    expect(child.spawnSync).toHaveBeenCalledOnce();
    const [file, args, options] = child.spawnSync.mock.calls[0]!;
    expect(file).toBe(phantom);
    expect(args.slice(0, 5)).toEqual(['exec', '--', 'gh', 'pr', 'list']);
    expect(options).toMatchObject({ cwd: root, encoding: 'utf8', stdio: 'pipe' });
    expect(options.timeout).toBeGreaterThan(0);
  });

  it('reads Vercel deployments through the same transport', () => {
    respond(JSON.stringify([{ url: 'fixture.example', state: 'READY', target: 'preview' }]));
    expect(listDeploys(root)).toMatchObject([{ url: 'fixture.example', state: 'READY' }]);
    expect(child.spawnSync).toHaveBeenCalledWith(phantom, ['exec', '--', 'vercel', 'ls', '--format', 'json'],
      expect.objectContaining({ cwd: root, timeout: 8_000, env: expect.objectContaining({ CI: '1', FORCE_COLOR: '0' }) }));
  });

  it('does not retry a failed Secrets invocation outside custody', () => {
    respond('', 1);
    expect(listPrs(root)).toEqual([]);
    expect(child.spawnSync).toHaveBeenCalledOnce();
    expect(child.spawnSync.mock.calls[0]![0]).toBe(phantom);
  });
});
