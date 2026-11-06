import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const fakes = vi.hoisted(() => ({
  installed: false,
  spawnSync: vi.fn(), execFileSync: vi.fn(), spawn: vi.fn(), execFile: vi.fn(),
  access: vi.fn(), stat: vi.fn(),
}));
vi.mock('node:child_process', () => ({
  spawnSync: fakes.spawnSync, execFileSync: fakes.execFileSync,
  spawn: fakes.spawn, execFile: fakes.execFile,
}));
vi.mock('node:fs', () => ({
  accessSync: fakes.access, statSync: fakes.stat, constants: { X_OK: 1 },
}));
import {
  credentialSpawnSync, credentialExecFileSync, credentialSpawn, credentialExecFile, providerSpawnSync,
} from '../src/core/integrations/secrets.js';

const phantomName = process.platform === 'win32' ? 'phantom.exe' : 'phantom';
const phantom = resolve('/synthetic/tools', phantomName);
const options = { cwd: '/synthetic/repo', env: { PATH: '/synthetic/tools', GH_TOKEN: 'phm_fixture' }, timeout: 123, encoding: 'utf8' as const };
let warning: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  fakes.installed = true;
  vi.stubEnv('LOCUS_SESSION_ID', undefined);
  vi.stubEnv('LOCUS_EXECUTOR_CAPABILITY', undefined);
  fakes.access.mockImplementation((candidate: string) => {
    if (!fakes.installed || candidate !== phantom) throw new Error('ENOENT');
  });
  fakes.stat.mockImplementation((candidate: string) => {
    if (!fakes.installed || candidate !== phantom) throw new Error('ENOENT');
    return { isFile: () => true };
  });
  fakes.spawnSync.mockReturnValue({ status: 0, stdout: 'result', stderr: '' });
  fakes.execFileSync.mockReturnValue('result');
  fakes.spawn.mockReturnValue({ pid: 123 });
  fakes.execFile.mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback === 'function') callback(null, 'output', 'diagnostic');
    return { pid: 123 };
  });
  warning = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});
afterEach(() => { warning.mockRestore(); vi.unstubAllEnvs(); });

describe('credential subprocess boundary', () => {
  it.each(['gh', 'npm', 'npx', 'pnpm', 'vercel', 'aws', 'stack', 'claude', '/opt/tools/gh', 'C:\\tools\\gh.exe'])(
    'wraps %s with argv and the exact child options', command => {
      const args = ['api', 'argument with spaces', '$(never execute)', '--token=phm_fixture'];
      expect(credentialSpawnSync(command, args, options)).toMatchObject({ status: 0 });
      expect(fakes.spawnSync).toHaveBeenCalledExactlyOnceWith(phantom, ['exec', '--', command, ...args], options);
      expect(warning).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['push', 'origin', 'HEAD'], ['fetch', 'origin'], ['clone', 'https://example.invalid/repo'],
    ['-C', '/repo', '-c', 'core.hooksPath=/dev/null', 'push', 'origin'],
    ['--git-dir=/repo/.git', 'ls-remote', 'origin'], ['remote', 'update'], ['remote', '--verbose', 'update'], ['remote', 'add', '-f', 'origin', 'url'],
    ['remote', 'set-head', 'origin', '--auto'], ['custom-alias'],
  ])('wraps remote Git invocation %j', (...args) => {
    credentialExecFileSync('git', args, options);
    expect(fakes.execFileSync).toHaveBeenCalledExactlyOnceWith(phantom, ['exec', '--', 'git', ...args], options);
  });
  it.each([
    ['git', ['status', '--porcelain']], ['git', ['-C', '/repo', 'rev-parse', 'HEAD']],
    ['git', ['remote', 'get-url', 'origin']], ['git', ['--version']],
    ['gh', ['--version']], ['node', ['script.js']], ['phantom', ['exec', '--', 'gh', 'api']],
  ] as const)('does not wrap local/already-wrapped %s %j', (command, args) => {
    credentialSpawn(command, [...args], options);
    expect(fakes.spawn).toHaveBeenCalledExactlyOnceWith(command, [...args], options);
    expect(fakes.access).not.toHaveBeenCalled();
  });
  it('falls back only when absent, with a value-free warning', () => {
    fakes.installed = false;
    credentialSpawnSync('gh', ['api', 'private/path'], options);
    credentialSpawnSync('npm', ['publish'], options);
    expect(fakes.spawnSync).toHaveBeenNthCalledWith(1, 'gh', ['api', 'private/path'], options);
    expect(warning).toHaveBeenCalledTimes(1);
    const message = String(warning.mock.calls[0]?.[0]);
    expect(message).toContain('without phantom exec');
    expect(message).not.toMatch(/private|phm_fixture|synthetic/);
  });
  it('does not fall back after a Secrets nonzero exit or launch error', () => {
    fakes.spawnSync.mockReturnValue({ status: 1, stderr: 'refused' });
    expect(credentialSpawnSync('gh', ['api'], options)).toMatchObject({ status: 1 });
    expect(fakes.spawnSync).toHaveBeenCalledTimes(1);
    fakes.execFileSync.mockImplementation(() => { throw new Error('refused'); });
    expect(() => credentialExecFileSync('gh', ['api'], options)).toThrow('refused');
    expect(fakes.execFileSync).toHaveBeenCalledTimes(1);
    expect(warning).not.toHaveBeenCalled();
  });
  it('does not treat denied executable discovery as an absent installation', () => {
    fakes.access.mockImplementation(() => { throw Object.assign(new Error('private path'), { code: 'EACCES' }); });
    expect(() => credentialSpawnSync('gh', [], options)).toThrow('discovery was denied');
    expect(fakes.spawnSync).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
  });
  it('refuses inherited jobs before discovery or dispatch', () => {
    vi.stubEnv('LOCUS_SESSION_ID', 'synthetic-session');
    expect(() => credentialSpawn('gh', ['api'], options)).toThrow('cannot use generic Secrets exec');
    expect(fakes.access).not.toHaveBeenCalled();
    expect(fakes.spawn).not.toHaveBeenCalled();
  });
  it('refuses explicitly delegated child environments and shell execution', () => {
    expect(() => credentialSpawnSync('gh', [], { env: { LOCUS_SESSION_ID: 'fixture' } })).toThrow('cannot use generic Secrets exec');
    expect(() => credentialSpawnSync('gh', [], { shell: true })).toThrow('without a shell');
    expect(fakes.access).not.toHaveBeenCalled();
    expect(fakes.spawnSync).not.toHaveBeenCalled();
  });
  it('preserves callback and args-omitted overloads', () => {
    const callback = vi.fn();
    credentialExecFile('gh', options, callback);
    expect(fakes.execFile).toHaveBeenCalledExactlyOnceWith(phantom, ['exec', '--', 'gh'], options, callback);
    expect(callback).toHaveBeenCalledWith(null, 'output', 'diagnostic');
  });
  it('preserves promisified stdout, stderr and child without bypassing the wrapper', async () => {
    const result = promisify(credentialExecFile)('gh', ['api'], options);
    expect(result.child).toEqual({ pid: 123 });
    await expect(result).resolves.toEqual({ stdout: 'output', stderr: 'diagnostic' });
    expect(fakes.execFile.mock.calls[0]?.slice(0, 3)).toEqual([phantom, ['exec', '--', 'gh', 'api'], options]);
  });
  it('preserves promisified error output and never retries', async () => {
    fakes.execFile.mockImplementation((...args: unknown[]) => {
      (args.at(-1) as (...args: unknown[]) => void)(new Error('failed'), 'partial', 'failure');
      return { pid: 123 };
    });
    await expect(promisify(credentialExecFile)('gh', [], options)).rejects.toMatchObject({ message: 'failed', stdout: 'partial', stderr: 'failure' });
    expect(fakes.execFile).toHaveBeenCalledTimes(1);
  });
  it('wraps arbitrary configured deployment binaries', () => {
    providerSpawnSync('/custom/provider', ['deploy'], options);
    expect(fakes.spawnSync).toHaveBeenCalledExactlyOnceWith(phantom, ['exec', '--', '/custom/provider', 'deploy'], options);
  });
  it('honors child PATH and ignores directories named phantom', () => {
    fakes.stat.mockReturnValue({ isFile: () => false });
    credentialSpawnSync('gh', [], options);
    expect(fakes.spawnSync).toHaveBeenCalledExactlyOnceWith('gh', [], options);
  });
});
