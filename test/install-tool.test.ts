import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdInstall } from '../src/cli/install.js';
import { installTool, type ResolvedInstall } from '../src/core/install/installer.js';
import type { InstallRunner } from '../src/core/install/process.js';

const npmFixture = (): ResolvedInstall => ({
  source: 'https://github.com/example/tool', evidence: ['phantom.install.json'], entrypoint: 'dist/server.js',
  manifest: { version: 1, id: 'example', install: { kind: 'npm', package: '@example/tool', version: '1.2.3', bin: 'example-mcp' }, mcp: { args: ['serve'] }, secrets: [] },
});
const gitFixture = (): ResolvedInstall => ({
  source: 'https://github.com/example/tool', evidence: ['phantom.install.json'], entrypoint: 'server.mjs',
  manifest: { version: 1, id: 'example', install: { kind: 'git', repo: 'example/tool', commit: 'a'.repeat(40), bin: 'server.mjs' }, mcp: { args: [] }, secrets: [] },
});

async function installedPackage(prefix: string, version = '1.2.3'): Promise<void> {
  const root = join(prefix, 'node_modules', '@example', 'tool');
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@example/tool', version, bin: { 'example-mcp': './dist/server.js' } }));
  await writeFile(join(root, 'dist', 'server.js'), 'export {};\n');
}

describe('project tool installer', () => {
  let project: string;
  let resolved: ResolvedInstall;
  let run: ReturnType<typeof vi.fn<InstallRunner>>;
  const resolve = async (): Promise<ResolvedInstall> => structuredClone(resolved);
  const install = (dryRun = false) => installTool('example/tool', { dir: project, dryRun, resolve, run });

  beforeEach(async () => {
    project = await realpath(await mkdtemp(join(tmpdir(), 'phm-install-test-')));
    resolved = npmFixture();
    run = vi.fn<InstallRunner>(async (command, args) => {
      expect(command).toBe('npm');
      await installedPackage(args[args.indexOf('--prefix') + 1]!);
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(project, { recursive: true, force: true });
  });

  it('dry-run resolves an exact plan without writing or starting a package manager', async () => {
    const result = await install(true);
    expect(result.status).toBe('planned');
    expect(result.registration?.command).toBe(process.execPath);
    expect(result.registration?.args).toEqual([join(result.directory, 'node_modules/@example/tool/dist/server.js'), 'serve']);
    expect(result.actions).toHaveLength(2);
    expect(run).not.toHaveBeenCalled();
    expect(await readdir(project)).toEqual([]);
  });

  it('installs a pinned package and preserves unrelated config and servers with a backup', async () => {
    const prior = JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'other-tool', args: [] } } });
    await writeFile(join(project, '.mcp.json'), prior);
    const result = await install();
    expect(result.status).toBe('installed');
    expect(run).toHaveBeenCalledOnce();
    const [, args, options] = run.mock.calls[0]!;
    expect(args).toEqual(expect.arrayContaining(['--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev', '--save-exact', '@example/tool@1.2.3']));
    expect(options.home.startsWith(join(project, '.phantom'))).toBe(true);
    const config = JSON.parse(await readFile(join(project, '.mcp.json'), 'utf8'));
    expect(config).toEqual({ theme: 'dark', mcpServers: { other: { command: 'other-tool', args: [] }, example: result.registration } });
    const backup = (await readdir(project)).find(name => name.startsWith('.mcp.json.phm-') && name.endsWith('.bak'));
    expect(backup).toBeDefined();
    expect(await readFile(join(project, backup!), 'utf8')).toBe(prior);
    expect(await readdir(result.directory)).not.toContain('.execution');
    expect(await readdir(join(project, '.phantom'))).toEqual(['tools']);
  });

  it('a repeat run verifies files and makes no install, registration or receipt writes', async () => {
    const first = await install();
    const configPath = join(project, '.mcp.json');
    const receiptPath = join(first.directory, 'receipt.json');
    const config = await readFile(configPath, 'utf8');
    const configStat = await stat(configPath);
    const receiptStat = await stat(receiptPath);
    run.mockClear();
    const second = await install();
    expect(second.status).toBe('unchanged');
    expect(second.actions).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(await readFile(configPath, 'utf8')).toBe(config);
    expect((await stat(configPath)).mtimeMs).toBe(configStat.mtimeMs);
    expect((await stat(receiptPath)).mtimeMs).toBe(receiptStat.mtimeMs);
  });

  it('repairs a missing registration from a verified install without reinstalling', async () => {
    await install();
    await rm(join(project, '.mcp.json'));
    run.mockClear();
    const result = await install();
    expect(result.status).toBe('installed');
    expect(run).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(join(project, '.mcp.json'), 'utf8')).mcpServers.example).toEqual(result.registration);
  });

  it.each(['{', '[]', '{"mcpServers":[]}', '{"mcpServers":null}'])('refuses invalid MCP config %s before downloading', async contents => {
    await writeFile(join(project, '.mcp.json'), contents);
    await expect(install()).rejects.toThrow(/JSON|configuration|mcpServers/);
    expect(run).not.toHaveBeenCalled();
    expect(await readFile(join(project, '.mcp.json'), 'utf8')).toBe(contents);
    expect(await readdir(project)).toEqual(['.mcp.json']);
  });

  it('preserves a conflicting server without downloading or creating a backup', async () => {
    const prior = JSON.stringify({ mcpServers: { example: { command: 'different-tool', args: [] } } });
    await writeFile(join(project, '.mcp.json'), prior);
    await expect(install()).rejects.toThrow(/registration differs/);
    expect(run).not.toHaveBeenCalled();
    expect(await readFile(join(project, '.mcp.json'), 'utf8')).toBe(prior);
    expect(await readdir(project)).toEqual(['.mcp.json']);
  });

  it('returns only vault-name requirements and makes no changes while secrets are pending', async () => {
    resolved.manifest.secrets = [{ env: 'SERVICE_API_KEY', name: 'service-access' }];
    const result = await install();
    expect(result.status).toBe('needs-secrets');
    expect(result.secretHook).toEqual({ version: 1, status: 'pending', references: [{ env: 'SERVICE_API_KEY', name: 'service-access' }] });
    expect(run).not.toHaveBeenCalled();
    expect(await readdir(project)).toEqual([]);
  });

  it('supports a CLI-only tool without reading or changing MCP config', async () => {
    delete resolved.manifest.mcp;
    await writeFile(join(project, '.mcp.json'), 'not JSON');
    const result = await install();
    expect(result.status).toBe('installed');
    expect(result.config).toBeNull();
    expect(result.registration).toBeNull();
    expect(await readFile(join(project, '.mcp.json'), 'utf8')).toBe('not JSON');
  });

  it.each(['.mcp.json', '.phantom'])('refuses a symlinked %s before installing', async name => {
    const target = join(project, 'elsewhere');
    if (name === '.phantom') await mkdir(target);
    else await writeFile(target, '{}');
    await symlink(target, join(project, name));
    await expect(install()).rejects.toThrow(/Unsafe install path/);
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses symlinked project roots and protected config directories', async () => {
    const alias = join(project, 'alias');
    await symlink(project, alias);
    await expect(installTool('example/tool', { dir: alias, resolve, run })).rejects.toThrow(/regular directory/);
    const protectedDir = join(project, '.codex-fixture');
    await mkdir(protectedDir);
    await expect(installTool('example/tool', { dir: protectedDir, resolve, run })).rejects.toThrow(/Protected/);
    expect(run).not.toHaveBeenCalled();
  });

  it.each(['../../escape.js', '/tmp/escape.js', 'dist/../escape.js'])('refuses escaping resolved entrypoint %s', async entrypoint => {
    resolved.entrypoint = entrypoint;
    await expect(install()).rejects.toThrow(/Unsafe tool entrypoint/);
    expect(run).not.toHaveBeenCalled();
    expect(await readdir(project)).toEqual([]);
  });

  it('cleans failed staging and releases its lock without registering the server', async () => {
    run.mockRejectedValue(new Error('simulated download failure'));
    await expect(install()).rejects.toThrow('simulated download failure');
    expect(await readdir(project)).not.toContain('.mcp.json');
    expect(await readdir(join(project, '.phantom'))).toEqual(['tools']);
  });

  it('preserves a concurrent config edit and leaves a reusable verified install', async () => {
    const changed = JSON.stringify({ mcpServers: { newlyAdded: { command: 'other' } } });
    run.mockImplementation(async (_command, args) => {
      await installedPackage(args[args.indexOf('--prefix') + 1]!);
      await writeFile(join(project, '.mcp.json'), changed);
    });
    await expect(install()).rejects.toThrow(/configuration changed/);
    expect(await readFile(join(project, '.mcp.json'), 'utf8')).toBe(changed);
    run.mockClear();
    const result = await install();
    expect(result.status).toBe('installed');
    expect(run).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(join(project, '.mcp.json'), 'utf8')).mcpServers.newlyAdded).toEqual({ command: 'other' });
  });

  it.each(['dist/server.js', 'package.json'])('repairs a matching installation with missing %s', async missing => {
    const first = await install();
    const missingPath = join(first.directory, 'node_modules/@example/tool', missing);
    await rm(missingPath);
    run.mockClear();
    const preview = await install(true);
    expect(preview.actions[0]).toMatch(/^Repair /);
    expect(run).not.toHaveBeenCalled();
    const repaired = await install();
    expect(repaired.status).toBe('installed');
    expect(run).toHaveBeenCalledOnce();
    expect((await stat(missingPath)).isFile()).toBe(true);
    expect(await readdir(join(project, '.phantom'))).toEqual(['tools']);
    expect((await install()).status).toBe('unchanged');
    expect(run).toHaveBeenCalledOnce();
  });

  it('preserves the prior receipt and directory when repair staging fails', async () => {
    const first = await install();
    const receiptPath = join(first.directory, 'receipt.json');
    const receipt = await readFile(receiptPath, 'utf8');
    const marker = join(first.directory, 'owner-note.txt');
    await writeFile(marker, 'retain this file');
    await rm(join(first.directory, 'node_modules/@example/tool/dist/server.js'));
    run.mockRejectedValue(new Error('simulated repair failure'));
    await expect(install()).rejects.toThrow('simulated repair failure');
    expect(await readFile(receiptPath, 'utf8')).toBe(receipt);
    expect(await readFile(marker, 'utf8')).toBe('retain this file');
    expect(await readdir(join(project, '.phantom'))).toEqual(['tools']);
  });

  it.each(['empty', 'populated'])('preserves an unknown %s destination before running installers', async kind => {
    const planned = await install(true);
    await mkdir(planned.directory, { recursive: true });
    if (kind === 'populated') await writeFile(join(planned.directory, 'owner-note.txt'), 'retain');
    await expect(install()).rejects.toThrow(/no matching receipt/);
    expect(run).not.toHaveBeenCalled();
    expect(await readdir(planned.directory)).toEqual(kind === 'populated' ? ['owner-note.txt'] : []);
    expect(await readdir(project)).not.toContain('.mcp.json');
  });

  it('preserves an unowned destination created while the package manager is running', async () => {
    const planned = await install(true);
    run.mockImplementation(async (_command, args) => {
      await installedPackage(args[args.indexOf('--prefix') + 1]!);
      await mkdir(planned.directory, { recursive: true });
    });
    await expect(install()).rejects.toThrow(/destination appeared/);
    expect(await readdir(planned.directory)).toEqual([]);
    expect(await readdir(project)).not.toContain('.mcp.json');
  });

  it('rejects a downloaded package whose version differs without publishing a receipt', async () => {
    run.mockImplementation(async (_command, args) => installedPackage(args[args.indexOf('--prefix') + 1]!, '9.9.9'));
    const planned = await install(true);
    await expect(install()).rejects.toThrow(/does not match/);
    await expect(stat(join(planned.directory, 'receipt.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(project)).not.toContain('.mcp.json');
  });

  it('refuses a tarball whose string bin does not provide the selected binary name', async () => {
    run.mockImplementation(async (_command, args) => {
      const prefix = args[args.indexOf('--prefix') + 1]!;
      await installedPackage(prefix);
      await writeFile(join(prefix, 'node_modules/@example/tool/package.json'), JSON.stringify({
        name: '@example/tool', version: '1.2.3', bin: './dist/server.js',
      }));
    });
    await expect(install()).rejects.toThrow('does not match');
    expect(await readdir(project)).not.toContain('.mcp.json');
  });

  it('refuses an installer lock held by another process', async () => {
    await mkdir(join(project, '.phantom/.install-lock'), { recursive: true });
    await expect(install()).rejects.toThrow(/project lock/);
    expect(run).not.toHaveBeenCalled();
    expect((await stat(join(project, '.phantom/.install-lock'))).isDirectory()).toBe(true);
  });

  it('fetches the exact Git commit with hardened flags and installs locked dependencies without scripts', async () => {
    resolved = gitFixture();
    run.mockImplementation(async (command, args, options) => {
      if (command === 'git' && args.includes('init')) await mkdir(join(options.cwd, 'repo'));
      if (command === 'git' && args.includes('checkout')) {
        const repo = join(options.cwd, 'repo');
        await writeFile(join(repo, 'server.mjs'), 'export {};\n');
        await writeFile(join(repo, 'package.json'), '{}');
        await writeFile(join(repo, 'package-lock.json'), '{}');
      }
    });
    const result = await install();
    expect(result.status).toBe('installed');
    const gitCalls = run.mock.calls.filter(([command]) => command === 'git');
    expect(gitCalls).toHaveLength(3);
    for (const [, args] of gitCalls) expect(args).toEqual(expect.arrayContaining(['core.hooksPath=/dev/null', 'credential.helper=', 'protocol.allow=never', 'protocol.https.allow=always']));
    expect(gitCalls[1]![1]).toEqual(expect.arrayContaining(['fetch', '--depth=1', '--no-tags', 'https://github.com/example/tool.git', 'a'.repeat(40), 'http.followRedirects=false']));
    expect(gitCalls[2]![1]).toEqual(expect.arrayContaining(['checkout', '--detach', 'a'.repeat(40)]));
    expect(run.mock.calls.find(([command]) => command === 'npm')?.[1]).toEqual(expect.arrayContaining(['ci', '--ignore-scripts', '--omit=dev']));
    expect(result.registration?.args).toEqual([join(result.directory, 'repo/server.mjs')]);
  });

  it.each(['missing-lock', 'npmrc'])('refuses Git dependency setup with %s', async reason => {
    resolved = gitFixture();
    run.mockImplementation(async (command, args, options) => {
      if (command === 'git' && args.includes('init')) await mkdir(join(options.cwd, 'repo'));
      if (command === 'git' && args.includes('checkout')) {
        const repo = join(options.cwd, 'repo');
        await writeFile(join(repo, 'server.mjs'), 'export {};\n');
        await writeFile(join(repo, 'package.json'), '{}');
        if (reason === 'npmrc') {
          await writeFile(join(repo, 'package-lock.json'), '{}');
          await writeFile(join(repo, '.npmrc'), 'ignore-scripts=false\n');
        }
      }
    });
    await expect(install()).rejects.toThrow(reason === 'missing-lock' ? /package-lock/ : /overrides/);
    expect(run.mock.calls.some(([command]) => command === 'npm')).toBe(false);
    expect(await readdir(project)).not.toContain('.mcp.json');
  });

  it('rejects a symlinked downloaded executable before registration', async () => {
    run.mockImplementation(async (_command, args) => {
      const prefix = args[args.indexOf('--prefix') + 1]!;
      await installedPackage(prefix);
      const executable = join(prefix, 'node_modules/@example/tool/dist/server.js');
      await rm(executable);
      const outside = join(project, 'outside.js');
      await writeFile(outside, 'export {};\n');
      await symlink(outside, executable);
    });
    await expect(install()).rejects.toThrow(/Unsafe install path/);
    expect(await readdir(project)).not.toContain('.mcp.json');
  });

});

describe('install command output', () => {
  afterEach(() => vi.restoreAllMocks());

  it('prints JSON help before resolving a source', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdInstall(['--help', '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({ client: 'Claude Code project .mcp.json' });
  });

  it.each([[], ['--dir'], ['example', 'second'], ['--dir', '--json']].map(args => ({ args })))('returns a machine-readable usage error for $args', async ({ args }) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdInstall([...args, '--json'])).toBe(1);
    expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({ ok: false, schema: 'phantom.install.result.v1', status: 'failed' });
  });

  it('never echoes a rejected source or unknown flag value', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const rejected = 'gh' + 'p_' + 'x'.repeat(36);
    expect(await cmdInstall([`--unknown=${rejected}`, '--json'])).toBe(1);
    expect(await cmdInstall([rejected, '--json'])).toBe(1);
    expect(log.mock.calls).toHaveLength(2);
    for (const [line] of log.mock.calls) {
      expect(line).not.toContain(rejected);
      expect(JSON.parse(line)).toMatchObject({ ok: false, status: 'failed' });
    }
  });
});
