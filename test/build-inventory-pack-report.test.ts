import { execFileSync } from 'node:child_process';
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NPM_BUILD_STEPS } from '../scripts/build-outputs.mjs';
import { runBuild } from '../scripts/build.mjs';
import { buildRuntimeReleaseDependencyInventory, type RuntimeReleasePackFileRecord } from '../src/core/daemon/runtime-release-dependency-inventory.js';

const roots: string[] = [];
const report = JSON.parse(readFileSync(new URL('./fixtures/build-inventory-pack-report/umask-077.json', import.meta.url), 'utf8')) as RuntimeReleasePackFileRecord[];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'build-pack-report-'));
  roots.push(root);
  const manifest = { name: 'fixture', version: '1.0.0', files: ['bin', 'dist', 'scripts/run-verify-command.mjs'], dependencies: {}, bundledDependencies: [] };
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'fixture', version: '1.0.0' } } }));
  return root;
}
/** Records shaped like `npm pack --dry-run --json` files: on-disk modes, as npm reports them. */
function packReport(root: string, directory = join(root, 'dist')): RuntimeReleasePackFileRecord[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return packReport(root, path);
    const stat = statSync(path);
    return [{ path: relative(root, path), size: stat.size, mode: stat.mode & 0o777 }];
  });
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('portable release build file modes', () => {
  it.skipIf(process.platform === 'win32')('creates portable child outputs under a restrictive caller mask', () => {
    const root = fixture();
    const script = `
      import { runBuild } from ${JSON.stringify(new URL('../scripts/build.mjs', import.meta.url).href)};
      import { spawnSync } from 'node:child_process';
      process.umask(0o077);
      const code = "require('node:fs').writeFileSync('output.js', 'fixture')";
      const status = runBuild([{command: 'fixture'}], () => spawnSync(process.execPath, ['-e', code], {cwd: ${JSON.stringify(root)}}), ${JSON.stringify(root)});
      console.log(status, process.umask().toString(8));
    `;
    expect(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }).trim()).toBe('0 77');
    const mode = Number(execFileSync(process.execPath, ['-e', `console.log(require('node:fs').statSync(${JSON.stringify(join(root, 'output.js'))}).mode & 0o777)`], { encoding: 'utf8' }).trim());
    const produced = report.map(file => ({ ...file, mode }));
    expect(buildRuntimeReleaseDependencyInventory(root, { packagedFiles: produced }).ok).toBe(true);
  });

  it('still rejects the actual restrictive-mask pack records', () => {
    expect(buildRuntimeReleaseDependencyInventory(fixture(), { packagedFiles: report })).toEqual({ ok: false, reason: 'npm pack file report is invalid' });
  });

  it.skipIf(process.platform === 'win32')('normalizes warm outputs without following symlinks or leaving declared roots', () => {
    const root = fixture();
    const dist = join(root, 'dist');
    const nested = join(dist, 'nested');
    mkdirSync(nested, { recursive: true });
    chmodSync(dist, 0o700);
    chmodSync(nested, 0o700);
    const warmOutput = join(nested, 'warm.js');
    writeFileSync(warmOutput, 'before');
    chmodSync(warmOutput, 0o600);
    const inode = statSync(warmOutput).ino;
    const executable = join(dist, 'run.sh');
    writeFileSync(executable, 'run');
    chmodSync(executable, 0o700);
    const declaredOutput = join(root, 'desktop', 'src-tauri', 'binaries', 'ashlr-fixture');
    mkdirSync(join(root, 'desktop', 'src-tauri', 'binaries'), { recursive: true });
    writeFileSync(declaredOutput, 'binary');
    chmodSync(declaredOutput, 0o600);
    const external = join(root, 'external.js');
    writeFileSync(external, 'external');
    chmodSync(external, 0o600);
    const undeclared = join(root, 'docs', 'private.js');
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(undeclared, 'private');
    chmodSync(undeclared, 0o600);
    const symlink = join(dist, 'external.js');
    symlinkSync(external, symlink);

    expect(runBuild([{ command: 'fixture' }], (_command, options) => {
      expect(options.cwd).toBe(root);
      writeFileSync(warmOutput, 'after');
      return { status: 0 };
    }, root)).toBe(0);
    expect(statSync(warmOutput).ino).toBe(inode);
    expect(statSync(warmOutput).mode & 0o777).toBe(0o644);
    expect(statSync(executable).mode & 0o777).toBe(0o755);
    expect(statSync(declaredOutput).mode & 0o777).toBe(0o644);
    expect(statSync(dist).mode & 0o777).toBe(0o755);
    expect(statSync(nested).mode & 0o777).toBe(0o755);
    expect(statSync(external).mode & 0o777).toBe(0o600);
    expect(statSync(undeclared).mode & 0o777).toBe(0o600);
    expect(lstatSync(symlink).isSymbolicLink()).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('breaks an output hard link before normalizing its mode', () => {
    const root = fixture();
    const dist = join(root, 'dist');
    mkdirSync(dist);
    const external = join(root, 'outside.js');
    writeFileSync(external, 'external');
    chmodSync(external, 0o600);
    const externalInode = statSync(external).ino;
    const output = join(dist, 'linked.js');
    linkSync(external, output);

    expect(statSync(output).ino).toBe(externalInode);
    expect(runBuild([], () => { throw new Error('unexpected spawn'); }, root)).toBe(0);

    expect(statSync(external).ino).toBe(externalInode);
    expect(statSync(external).mode & 0o777).toBe(0o600);
    expect(statSync(output).ino).not.toBe(externalInode);
    expect(statSync(output).mode & 0o777).toBe(0o644);
  });

  it.skipIf(process.platform === 'win32')('normalizes warm restrictive outputs before the inventory step validates pack modes', () => {
    const root = fixture();
    const nested = join(root, 'dist', 'api');
    mkdirSync(nested, { recursive: true });
    const warm = join(nested, 'bot-templates.js');
    writeFileSync(warm, 'warm');
    chmodSync(warm, 0o600);
    chmodSync(nested, 0o700);
    chmodSync(join(root, 'dist'), 0o700);
    const copied = join(root, 'dist', 'asset.json');
    const seen: string[] = [];
    let inventory: ReturnType<typeof buildRuntimeReleaseDependencyInventory> | undefined;
    let directoryMode: number | undefined;

    expect(runBuild(NPM_BUILD_STEPS, (command: string) => {
      seen.push(command);
      if (command === 'node scripts/copy-assets.mjs') {
        writeFileSync(copied, '{}');
        chmodSync(copied, 0o600);
      }
      if (command.includes('build-release-dependency-inventory')) {
        directoryMode = statSync(nested).mode & 0o777;
        inventory = buildRuntimeReleaseDependencyInventory(root, { packagedFiles: packReport(root) });
        return { status: inventory.ok ? 0 : 1 };
      }
      return { status: 0 };
    }, root)).toBe(0);
    expect(inventory).toMatchObject({ ok: true });
    expect(directoryMode).toBe(0o755);
    expect(seen).toEqual(NPM_BUILD_STEPS.map(step => step.command));
    expect(statSync(warm).mode & 0o777).toBe(0o644);
    expect(statSync(copied).mode & 0o777).toBe(0o644);
  });

  it.skipIf(process.platform === 'win32')('normalizes warm outputs before the first step runs', () => {
    const root = fixture();
    const dist = join(root, 'dist');
    mkdirSync(dist);
    chmodSync(dist, 0o700);
    const warm = join(dist, 'warm.js');
    writeFileSync(warm, 'warm');
    chmodSync(warm, 0o600);
    expect(runBuild([{ command: 'first' }], () => {
      expect(statSync(dist).mode & 0o777).toBe(0o755);
      expect(statSync(warm).mode & 0o777).toBe(0o644);
      return { status: 0 };
    }, root)).toBe(0);
  });

  it.each([
    { path: '../escape', size: 1, mode: 0o644 },
    { path: 'dist/a.js', size: -1, mode: 0o644 },
    { path: 'dist/a.js', size: 128 * 1024 * 1024 + 1, mode: 0o644 },
    { path: 'dist/a.js', size: 1, mode: 0o777 },
    { path: 'dist/a.js', size: 1, mode: 0o644, extra: true },
  ])('rejects malformed or tampered records: %j', file => {
    expect(buildRuntimeReleaseDependencyInventory(fixture(), { packagedFiles: [file] })).toEqual({ ok: false, reason: 'npm pack file report is invalid' });
  });

  it('rejects case-colliding paths', () => {
    const files = ['dist/a.js', 'dist/A.js'].map(path => ({ path, size: 1, mode: 0o644 }));
    expect(buildRuntimeReleaseDependencyInventory(fixture(), { packagedFiles: files }).ok).toBe(false);
  });

  it('accepts an empty build and empty dependency report', () => {
    expect(runBuild([], () => { throw new Error('unexpected spawn'); }, fixture())).toBe(0);
    expect(buildRuntimeReleaseDependencyInventory(fixture(), { packagedFiles: [] }).ok).toBe(true);
  });

  it('stops on failure and restores the creation mask', () => {
    const mask = process.umask();
    const root = fixture();
    const warmOutput = join(root, 'dist', 'warm.js');
    mkdirSync(join(root, 'dist'));
    writeFileSync(warmOutput, 'before');
    chmodSync(warmOutput, 0o600);
    const later = join(root, 'dist', 'later.js');
    expect(runBuild([{ command: 'fail' }, { command: 'unreachable' }], () => {
      writeFileSync(later, 'later');
      chmodSync(later, 0o600);
      return { status: 7 };
    }, root)).toBe(7);
    expect(statSync(warmOutput).mode & 0o777).toBe(0o644);
    expect(statSync(later).mode & 0o777).toBe(0o600);
    expect(process.umask()).toBe(mask);
    expect(() => runBuild([{ command: 'error' }], () => ({ error: new Error('spawn failed') }), root)).toThrow('spawn failed');
    expect(process.umask()).toBe(mask);
  });
});
