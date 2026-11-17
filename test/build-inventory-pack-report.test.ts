import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('portable release build file modes', () => {
  it.skipIf(process.platform === 'win32')('creates portable child outputs under a restrictive caller mask', () => {
    const root = fixture();
    const script = `
      import { runBuild } from ${JSON.stringify(new URL('../scripts/build.mjs', import.meta.url).href)};
      import { spawnSync } from 'node:child_process';
      process.umask(0o077);
      const code = "require('node:fs').writeFileSync('output.js', 'fixture')";
      const status = runBuild([{command: 'fixture'}], () => spawnSync(process.execPath, ['-e', code], {cwd: ${JSON.stringify(root)}}));
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
    expect(runBuild([], () => { throw new Error('unexpected spawn'); })).toBe(0);
    expect(buildRuntimeReleaseDependencyInventory(fixture(), { packagedFiles: [] }).ok).toBe(true);
  });

  it('stops on failure and restores the creation mask', () => {
    const mask = process.umask();
    expect(runBuild([{ command: 'fail' }, { command: 'unreachable' }], () => ({ status: 7 }))).toBe(7);
    expect(process.umask()).toBe(mask);
    expect(() => runBuild([{ command: 'error' }], () => ({ error: new Error('spawn failed') }))).toThrow('spawn failed');
    expect(process.umask()).toBe(mask);
  });
});
