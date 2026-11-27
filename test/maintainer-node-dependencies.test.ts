import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  needsMaintainerNode, prepareMaintainerNodeDependencies, validateMaintainerNodeLockfile,
  type MaintainerNodeManager,
} from '../src/core/fleet/maintainer-node-dependencies.js';
import { runVerifySubprocessAsync, type VerifyCommand } from '../src/core/run/verify-commands.js';

const integrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
const tarball = 'https://registry.npmjs.org/foo/-/foo-1.0.0.tgz';
const roots: string[] = [];

function root(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'maintainer-node-deps-test-')));
  roots.push(path);
  return path;
}

function lockDocument(manager: MaintainerNodeManager, variant = 'valid'): Record<string, unknown> {
  const resolution = variant === 'git'
    ? 'git+https://github.com/example/foo.git#abcdef'
    : variant === 'file'
      ? 'file:../../outside'
      : variant === 'link'
        ? 'link:../../outside'
        : variant === 'http'
          ? 'http://registry.npmjs.org/foo/-/foo-1.0.0.tgz'
          : variant === 'custom-registry'
            ? 'https://registry.example.test/foo/-/foo-1.0.0.tgz'
            : tarball;
  const withIntegrity = variant !== 'missing-integrity';
  if (manager === 'pnpm') {
    const packageResolution: Record<string, unknown> = variant === 'git'
      ? { repo: resolution, commit: 'abcdef', integrity }
      : typeof resolution === 'string' ? { tarball: resolution, ...(withIntegrity ? { integrity } : {}) } : {};
    const doc: Record<string, unknown> = {
      lockfileVersion: variant === 'unsupported-version' ? '10.0' : '9.0',
      importers: { '.': {} },
      packages: { 'foo@1.0.0': { resolution: packageResolution } },
    };
    if (variant === 'patched') doc['patchedDependencies'] = {};
    return doc;
  }
  if (manager === 'bun') {
    const doc: Record<string, unknown> = {
      lockfileVersion: variant === 'unsupported-version' ? 2 : 1,
      workspaces: { '': {} },
      packages: {
        foo: [resolution, '', {}, ...(withIntegrity ? [integrity] : [])],
      },
    };
    if (variant === 'patched') doc['patchedDependencies'] = {};
    return doc;
  }
  const packageEntry: Record<string, unknown> = variant === 'git'
    ? { version: '1.0.0', resolved: resolution, integrity }
    : { version: '1.0.0', resolved: resolution, ...(withIntegrity ? { integrity } : {}) };
  const doc: Record<string, unknown> = {
    lockfileVersion: variant === 'unsupported-version' ? 2 : 3,
    packages: { '': { name: 'fixture', version: '1.0.0' }, 'node_modules/foo': packageEntry },
  };
  if (variant === 'link') {
    packageEntry['link'] = true;
    packageEntry['resolved'] = '../../outside';
  }
  if (variant === 'patched') doc['patchedDependencies'] = {};
  return doc;
}

function lockText(manager: MaintainerNodeManager, variant = 'valid'): string {
  return JSON.stringify(lockDocument(manager, variant));
}

function command(manager: string, cwd?: string): VerifyCommand {
  return { id: `${manager}-test`, kind: 'test', cmd: [manager, 'run', 'test'], ...(cwd ? { cwd } : {}), required: true };
}

function project(worktree: string, manager: MaintainerNodeManager): void {
  writeFileSync(join(worktree, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node -e "true"' } }));
  const file = manager === 'pnpm' ? 'pnpm-lock.yaml' : manager === 'bun' ? 'bun.lock' : 'package-lock.json';
  writeFileSync(join(worktree, file), lockText(manager));
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('maintainer Node lockfile validation', () => {
  it.each(['pnpm', 'bun', 'npm'] as const)('accepts registry packages with sha512 integrity in %s locks', (manager) => {
    const worktree = root();
    expect(validateMaintainerNodeLockfile(manager, lockText(manager), worktree)).toBe(1);
  });
  it('parses the pnpm YAML lockfile schema directly', () => {
    const worktree = root();
    const text = `lockfileVersion: '9.0'
importers:
  .: {}
packages:
  foo@1.0.0:
    resolution:
      integrity: '${integrity}'
      tarball: '${tarball}'
`;
    expect(validateMaintainerNodeLockfile('pnpm', text, worktree)).toBe(1);
  });
  it.each(['pnpm', 'bun', 'npm'] as const)('accepts an in-workspace link in %s locks', (manager) => {
    const worktree = root();
    mkdirSync(join(worktree, 'packages', 'local'), { recursive: true });
    writeFileSync(join(worktree, 'package.json'), JSON.stringify({ name: 'fixture' }));
    writeFileSync(join(worktree, 'packages', 'local', 'package.json'), JSON.stringify({ name: 'local-package' }));
    let doc: Record<string, unknown>;
    if (manager === 'pnpm') {
      doc = {
        lockfileVersion: '9.0',
        importers: { '.': {}, 'packages/local': {} },
        packages: { 'local-package@1.0.0': { resolution: { directory: 'packages/local', type: 'directory' } } },
      };
    } else if (manager === 'bun') {
      doc = {
        lockfileVersion: 1,
        workspaces: { '': {}, 'packages/local': {} },
        packages: { 'local-package': ['workspace:packages/local', '', {}] },
      };
    } else {
      doc = {
        lockfileVersion: 3,
        packages: { '': { name: 'fixture' }, 'node_modules/local-package': { link: true, resolved: 'packages/local' } },
      };
    }
    expect(validateMaintainerNodeLockfile(manager, JSON.stringify(doc), worktree)).toBe(1);
  });

  it.each([
    ['git', 'git-source'],
    ['file', 'workspace-link-outside'],
    ['link', 'workspace-link-outside'],
    ['http', 'insecure-tarball'],
    ['custom-registry', 'custom-registry'],
    ['missing-integrity', 'missing-sha512-integrity'],
    ['patched', 'patched-dependencies'],
    ['unsupported-version', 'unsupported-lockfile-version'],
  ])('refuses %s packages in every supported lock format', (variant, reason) => {
    const worktree = root();
    for (const manager of ['pnpm', 'bun', 'npm'] as const) {
      expect(() => validateMaintainerNodeLockfile(manager, lockText(manager, variant), worktree), `${manager} ${variant}`)
        .toThrow(reason);
    }
  });

  it('parses JSONC comments and trailing commas without rewriting quoted strings', () => {
    const worktree = root();
    const text = `{
      // lockfile comment
      "lockfileVersion": 1,
      "workspaces": { "": { "name": "fixture", }, },
      "packages": {
        "foo": ["foo@1.0.0", "", { "note": "// retained text" }, "${integrity}",],
      },
    }`;
    expect(validateMaintainerNodeLockfile('bun', text, worktree)).toBe(1);
    expect(() => validateMaintainerNodeLockfile('bun', '{"lockfileVersion":1, /*', worktree)).toThrow('malformed-bun-lock');
  });

  it('rejects package inventories above 20,000 entries', () => {
    const worktree = root();
    const packages = Object.fromEntries(Array.from({ length: 20_001 }, (_, index) => [`foo@${index}`, {}]));
    const text = JSON.stringify({ lockfileVersion: '9.0', importers: {}, packages });
    expect(() => validateMaintainerNodeLockfile('pnpm', text, worktree)).toThrow('package-count-limit');
  });

  it('detects all Node package-manager command forms', () => {
    expect(needsMaintainerNode(['pnpm', 'bun', 'npm', 'npx', 'yarn'].map((manager) => command(manager)))).toBe(true);
    expect(needsMaintainerNode([command('node')])).toBe(false);
  });
});

describe('maintainer Node dependency preparation', () => {
  it('refuses binary bun.lockb and hostile npm configuration before resolving a manager or running an install', async () => {
    const worktree = root();
    writeFileSync(join(worktree, 'package.json'), JSON.stringify({ name: 'fixture' }));
    writeFileSync(join(worktree, 'bun.lockb'), Buffer.from([0, 1, 2]));
    const runSubprocess = vi.fn();
    const resolveBinary = vi.fn(() => ({ executable: process.execPath, binDirs: [dirname(process.execPath)] }));
    await expect(prepareMaintainerNodeDependencies({
      worktree, sourceTree: 'a'.repeat(40), commands: [command('bun')], assertAuthorized() {},
    }, { runSubprocess: runSubprocess as never, resolveBinary })).rejects.toThrow('bun-lockb-refused');
    expect(resolveBinary).not.toHaveBeenCalled();
    expect(runSubprocess).not.toHaveBeenCalled();

    rmSync(join(worktree, 'bun.lockb'));
    project(worktree, 'pnpm');
    writeFileSync(join(worktree, '.npmrc'), 'registry=https://registry.example.test/\n');
    await expect(prepareMaintainerNodeDependencies({
      worktree, sourceTree: 'a'.repeat(40), commands: [command('pnpm')], assertAuthorized() {},
    }, { runSubprocess: runSubprocess as never, resolveBinary })).rejects.toThrow('disallowed-package-config');
    expect(resolveBinary).not.toHaveBeenCalled();
    expect(runSubprocess).not.toHaveBeenCalled();
  });

  it('validates every project lock before starting any install', async () => {
    const worktree = root();
    project(worktree, 'pnpm');
    mkdirSync(join(worktree, 'packages', 'app'), { recursive: true });
    writeFileSync(join(worktree, 'packages', 'app', 'package.json'), JSON.stringify({ name: 'app' }));
    writeFileSync(join(worktree, 'packages', 'app', 'package-lock.json'), lockText('npm', 'http'));
    const runSubprocess = vi.fn();
    const resolveBinary = vi.fn(() => ({ executable: process.execPath, binDirs: [dirname(process.execPath)] }));
    await expect(prepareMaintainerNodeDependencies({
      worktree, sourceTree: 'a'.repeat(40), commands: [command('pnpm'), command('npm', 'packages/app')], assertAuthorized() {},
    }, { runSubprocess: runSubprocess as never, resolveBinary })).rejects.toThrow('insecure-tarball');
    expect(resolveBinary).not.toHaveBeenCalled();
    expect(runSubprocess).not.toHaveBeenCalled();
  });

  it('rejects traversal and symlink-escaped command working directories', async () => {
    const worktree = root();
    project(worktree, 'pnpm');
    const deps = {
      resolveBinary: () => ({ executable: process.execPath, binDirs: [dirname(process.execPath)] }),
      runSubprocess: vi.fn(),
    };
    await expect(prepareMaintainerNodeDependencies({
      worktree, sourceTree: 'a'.repeat(40), commands: [command('pnpm', '../outside')], assertAuthorized() {},
    }, deps as never)).rejects.toThrow('unsafe-command-cwd');

    if (process.platform !== 'win32') {
      const outside = root();
      const link = join(worktree, 'escape');
      symlinkSync(outside, link, 'dir');
      await expect(prepareMaintainerNodeDependencies({
        worktree, sourceTree: 'a'.repeat(40), commands: [command('pnpm', 'escape')], assertAuthorized() {},
      }, deps as never)).rejects.toThrow('command-cwd-symlink-escape');
    }
  });

  it.each([
    ['pnpm', ['install', '--frozen-lockfile', '--ignore-scripts', '--config.registry=https://registry.npmjs.org/']],
    ['bun', ['install', '--frozen-lockfile', '--ignore-scripts']],
    ['npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']],
  ] as const)('uses the exact isolated %s install argv and tracks node_modules identity', async (manager, args) => {
    const worktree = root();
    project(worktree, manager);
    vi.stubEnv('HOME', '/host/home');
    vi.stubEnv('NPM_TOKEN', 'host-only-token');
    vi.stubEnv('NODE_AUTH_TOKEN', 'host-node-token');
    vi.stubEnv('GITHUB_TOKEN', 'host-github-token');
    vi.stubEnv('npm_config_userconfig', '/host/.npmrc');
    const controller = new AbortController();
    const invocations: { argv: string[]; options: Parameters<typeof runVerifySubprocessAsync>[1] }[] = [];
    const runSubprocess: typeof runVerifySubprocessAsync = async (argv, options) => {
      invocations.push({ argv: [...argv], options });
      mkdirSync(join(options.cwd, 'node_modules'));
      return { stdout: '', stderr: '', exitCode: 0, signal: null, timedOut: false, cancelled: false, processGroupSettlement: 'group-exit-confirmed' };
    };
    const attachment = await prepareMaintainerNodeDependencies({
      worktree, sourceTree: 'a'.repeat(40), commands: [command(manager)], signal: controller.signal, assertAuthorized() {},
    }, {
      runSubprocess,
      resolveBinary: () => ({ executable: process.execPath, binDirs: [dirname(process.execPath)] }),
    });
    try {
      expect(invocations).toHaveLength(1);
      expect(invocations[0]!.argv).toEqual([process.execPath, ...args]);
      const env = invocations[0]!.options.env;
      expect(env['HOME']).not.toBe('/host/home');
      expect(env['HOME']).toBeTruthy();
      expect(statSync(env['HOME']!).mode & 0o777).toBe(0o700);
      expect(env['npm_config_registry']).toBe('https://registry.npmjs.org/');
      expect(env['npm_config_userconfig']).not.toBe('/host/.npmrc');
      expect(env['NPM_TOKEN']).toBeUndefined();
      expect(env['NODE_AUTH_TOKEN']).toBeUndefined();
      expect(env['GITHUB_TOKEN']).toBeUndefined();
      expect(JSON.stringify(env)).not.toContain('host-only-token');
      expect(JSON.stringify(env)).not.toContain('host-node-token');
      expect(JSON.stringify(env)).not.toContain('host-github-token');
      expect(env['PATH']).toBe([dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter));
      expect(env['npm_config_cache']).toContain(join('cache', manager));
      if (manager === 'pnpm') expect(env['npm_config_store_dir']).toBe(env['npm_config_cache']);
      if (manager === 'bun') expect(env['BUN_INSTALL_CACHE_DIR']).toBe(env['npm_config_cache']);
      expect(env['COREPACK_HOME']).toContain('corepack');
      expect(env['COREPACK_ENABLE_NETWORK']).toBe('0');
      expect(invocations[0]!.options.requireProcessGroupExit).toBe(true);
      expect(invocations[0]!.options.timeoutMs).toBe(300_000);
      expect(invocations[0]!.options.signal).toBe(controller.signal);
      expect(attachment.receipts).toMatchObject([{
        v: 1, recipe: 'node-locked-v1', manager, sourceTree: 'a'.repeat(40), packageCount: 1,
        lockSha256: createHash('sha256').update(lockText(manager)).digest('hex'),
      }]);
      expect(() => attachment.assertCurrent(worktree)).not.toThrow();
      const lockFile = join(worktree, manager === 'pnpm' ? 'pnpm-lock.yaml' : manager === 'bun' ? 'bun.lock' : 'package-lock.json');
      writeFileSync(lockFile, `${lockText(manager)} `);
      expect(() => attachment.assertCurrent(worktree)).toThrow('dependency-attachment-changed');
      writeFileSync(lockFile, lockText(manager));
      expect(() => attachment.assertCurrent(worktree)).not.toThrow();
      writeFileSync(join(worktree, 'node_modules', 'mutated.txt'), 'changed');
      expect(() => attachment.assertCurrent(worktree)).toThrow('dependency-attachment-changed');
      expect(existsSync(env['HOME']!)).toBe(true);
    } finally {
      const home = invocations[0]!.options.env['HOME']!;
      const tempRoot = join(home, '..');
      attachment.close();
      expect(existsSync(tempRoot)).toBe(false);
      expect(existsSync(join(worktree, 'node_modules'))).toBe(true);
    }
  });

  it('requires process-group settlement and cleans a failed installation', async () => {
    const worktree = root();
    project(worktree, 'npm');
    let privateHome = '';
    await expect(prepareMaintainerNodeDependencies({
      worktree, sourceTree: 'a'.repeat(40), commands: [command('npm')], assertAuthorized() {},
    }, {
      resolveBinary: () => ({ executable: process.execPath, binDirs: [dirname(process.execPath)] }),
      runSubprocess: async (_argv, options) => {
        privateHome = options.env['HOME']!;
        mkdirSync(join(options.cwd, 'node_modules'));
        return { stdout: '', stderr: '', exitCode: 0, signal: null, timedOut: false, cancelled: false, processGroupSettlement: 'unconfirmed' };
      },
    })).rejects.toThrow('install-failed-or-unsettled');
    expect(existsSync(privateHome)).toBe(false);
    expect(existsSync(join(worktree, 'node_modules'))).toBe(false);
  });
});
