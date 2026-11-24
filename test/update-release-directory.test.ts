import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { create } from 'tar';
import { detectReleaseDirectory, updateReleaseDirectory } from '../src/core/update/release-directory.js';
import { probeNpmRegistry } from '../src/core/update/registry.js';

let home: string, root: string, base: string, bytes: Buffer;
const run = vi.fn(), fetcher = vi.fn();
const services = () => ['gui/owner/ai.ashlr.daemon', 'gui/owner/ai.ashlr.serve'];
const missing = () => ({ status: null, error: Object.assign(new Error('missing'), { code: 'ENOENT' }) });
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'release-update-'))); base = join(home, '.local/share/ashlr');
  root = join(base, 'releases/previousprevious');
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(join(home, '.local/bin'), { recursive: true });
  fs.writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@ashlr/phantom', version: '1.0.0' }));
  fs.mkdirSync(join(root, 'bin')); fs.writeFileSync(join(root, 'bin/ashlr'), 'previous binary');
  fs.symlinkSync(root, join(base, 'current')); fs.symlinkSync(join(root, 'bin/ashlr'), join(home, '.local/bin/phm'));
  fs.mkdirSync(join(home, 'package/bin'), { recursive: true });
  fs.writeFileSync(join(home, 'package/package.json'), JSON.stringify({ name: '@ashlr/phantom', version: '1.0.1' }));
  fs.writeFileSync(join(home, 'package/bin/ashlr'), 'candidate binary');
  create({ cwd: home, file: join(home, 'candidate.tgz'), gzip: true, sync: true }, ['package']);
  bytes = fs.readFileSync(join(home, 'candidate.tgz'));
  run.mockReset(); fetcher.mockReset(); vi.stubGlobal('fetch', fetcher);
  run.mockImplementation((command: string) => command === 'gh' ? missing() : { status: 0, stdout: '1.0.1\n' });
  fetcher.mockImplementation(async (url: string) => new Response(url.endsWith('/latest') ? JSON.stringify({
    name: '@ashlr/phantom', version: '1.0.1', dist: {
      tarball: 'https://registry.npmjs.org/@ashlr/phantom/-/phantom-1.0.1.tgz',
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    },
  }) : bytes));
});
afterEach(() => { vi.unstubAllGlobals(); fs.rmSync(home, { recursive: true, force: true }); });
const update = (extra = {}) => updateReleaseDirectory(root, { home, run, ...extra });
const unchanged = () => {
  expect(fs.realpathSync(join(base, 'current'))).toBe(root);
  expect(fs.realpathSync(join(home, '.local/bin/phm'))).toBe(join(root, 'bin/ashlr'));
};

describe('release directory update', () => {
  it('detects only the exact release layout outside git', () => {
    expect(detectReleaseDirectory(root, home)).toBe(true);
    for (const path of [base, join(base, 'releases'), join(root, 'nested'), join(home, 'checkout')]) expect(detectReleaseDirectory(path, home)).toBe(false);
    fs.mkdirSync(join(root, '.git')); expect(detectReleaseDirectory(root, home)).toBe(false);
  });
  it('leaves both links unchanged when integrity fails', async () => {
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ name: '@ashlr/phantom', version: '1.0.1',
      dist: { tarball: 'https://registry.npmjs.org/@ashlr/phantom/-/phantom-1.0.1.tgz', integrity: `sha512-${'words'.repeat(18)}` } })));
    expect(await update()).toMatchObject({ verified: false, updated: false, rolled_back: false }); unchanged();
    expect(run).not.toHaveBeenCalled();
  });
  it('rejects downloaded bytes that do not match the registry digest', async () => {
    fetcher.mockImplementationOnce(async () => new Response(JSON.stringify({ name: '@ashlr/phantom', version: '1.0.1',
      dist: { tarball: 'https://registry.npmjs.org/@ashlr/phantom/-/phantom-1.0.1.tgz',
        integrity: `sha512-${createHash('sha512').update('different bytes').digest('base64')}` } })));
    expect(await update()).toMatchObject({ error: 'Release integrity verification failed', verified: false }); unchanged();
  });
  it('leaves the previous release active when smoke fails', async () => {
    run.mockImplementation((command: string) => command === 'gh' ? missing() : { status: 1 });
    expect(await update()).toMatchObject({ updated: false, verified: true, rolled_back: false }); unchanged();
  });
  it('runs a real executable smoke test without npm installation', async () => {
    fs.writeFileSync(join(home, 'package/bin/ashlr'), '#!/usr/bin/env node\nconsole.log("1.0.1");\n');
    create({ cwd: home, file: join(home, 'candidate.tgz'), gzip: true, sync: true }, ['package']);
    bytes = fs.readFileSync(join(home, 'candidate.tgz'));
    run.mockImplementation((command: string, args: string[]) => command === 'gh' ? missing() : spawnSync(command, args, { encoding: 'utf8', timeout: 5000 }));
    expect(await update()).toMatchObject({ updated: true, error: null });
  });
  it('rejects archive links before extraction', async () => {
    fs.symlinkSync('bin/ashlr', join(home, 'package/linked'));
    create({ cwd: home, file: join(home, 'candidate.tgz'), gzip: true, sync: true }, ['package']);
    bytes = fs.readFileSync(join(home, 'candidate.tgz'));
    expect(await update()).toMatchObject({ error: 'Release archive contains unsafe entries', updated: false }); unchanged();
  });
  it('recovers paused services when a later pause fails', async () => {
    run.mockImplementation((command: string, args: string[]) => command === 'gh' ? missing()
      : { status: args[0] === 'kill' && args[2] === services()[1] ? 1 : 0, stdout: '1.0.1' });
    expect(await update({ services })).toMatchObject({ updated: false, error: 'Service kill failed' }); unchanged();
    expect(run.mock.calls.filter(call => call[1][0] === 'kickstart')).toHaveLength(2);
  });
  it('refuses a second updater without removing its lock', async () => {
    fs.mkdirSync(join(base, '.update-lock'));
    expect(await update()).toMatchObject({ updated: false }); unchanged();
    expect(fs.existsSync(join(base, '.update-lock'))).toBe(true); expect(run).not.toHaveBeenCalled();
  });
  it('swaps current and the direct CLI link and keeps the previous release', async () => {
    const result = await update({ services });
    expect(result).toMatchObject({ from: '1.0.0', to: '1.0.1', verified: true, updated: true, rolled_back: false, attestation: 'unknown', error: null });
    expect(fs.realpathSync(join(base, 'current'))).not.toBe(root);
    expect(fs.readlinkSync(join(home, '.local/bin/phm'))).toBe(join(base, 'current/phm'));
    expect(fs.readFileSync(join(root, 'bin/ashlr'), 'utf8')).toBe('previous binary');
    expect(fs.readFileSync(join(home, '.ashlr-runs/installs.log'), 'utf8')).toBe(result.log_line + '\n');
    expect(run.mock.calls.filter(call => call[0] === 'launchctl').map(call => call[1])).toEqual([
      ...services().map(target => ['kill', 'SIGSTOP', target]), ...services().map(target => ['kickstart', '-k', target]),
    ]);
    expect(run.mock.calls.find(call => call[0] !== 'gh')?.[1]).toEqual(['--version']);
  });
  it('rolls back both links and restarts old services after restart failure', async () => {
    let failed = false;
    run.mockImplementation((command: string, args: string[]) => {
      if (command === 'gh') return missing();
      if (args[0] === 'kickstart' && !failed) { failed = true; return { status: 1 }; }
      return { status: 0, stdout: '1.0.1' };
    });
    expect(await update({ services })).toMatchObject({ updated: false, rolled_back: true, error: 'Service kickstart failed' }); unchanged();
    expect(run.mock.calls.filter(call => call[1][0] === 'kickstart')).toHaveLength(3);
  });
  it('requires attestation success whenever gh is installed', async () => {
    run.mockReturnValue({ status: 0, stdout: '1.0.1' });
    expect(await update()).toMatchObject({ attestation: 'verified', updated: true });
    expect(run.mock.calls[1]?.[1]).toEqual(['attestation', 'verify', expect.any(String), '--repo', 'ashlrai/phantom', '--hostname', 'github.com']);
  });
  it('does not unpack or switch after a failed attestation', async () => {
    run.mockImplementation((_command: string, args: string[]) => ({ status: args[0] === 'attestation' ? 1 : 0 }));
    expect(await update()).toMatchObject({ updated: false, verified: false, error: 'Release attestation failed' }); unchanged();
  });
  it('checks without smoke, service changes, links, or install logs', async () => {
    expect(await update({ check: true })).toMatchObject({ from: '1.0.0', to: '1.0.1', updated: false, log_line: '' });
    expect(run).not.toHaveBeenCalled(); expect(fs.existsSync(join(home, '.ashlr-runs'))).toBe(false); unchanged();
  });
});
describe('public npm registry probe', () => {
  it.each([200, 201, 299])('accepts HTTP %s with credentials omitted', async status => {
    fetcher.mockResolvedValueOnce(new Response('{}', { status }));
    expect(await probeNpmRegistry('@ashlr/phantom')).toEqual({ reachable: true, metadata: {} });
    expect(fetcher).toHaveBeenCalledWith('https://registry.npmjs.org/%40ashlr%2Fphantom/latest', expect.objectContaining({ credentials: 'omit', redirect: 'error' }));
  });
  it('keeps a successful empty response reachable', async () => {
    fetcher.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await probeNpmRegistry('@ashlr/phantom')).toEqual({ reachable: true, metadata: null });
  });
  it('reports failed status and network errors as unreachable', async () => {
    fetcher.mockResolvedValueOnce(new Response('', { status: 503 })).mockRejectedValueOnce(new Error('offline'));
    for (let attempt = 0; attempt < 2; attempt++) expect(await probeNpmRegistry('@ashlr/phantom')).toEqual({ reachable: false, metadata: null });
  });
});
