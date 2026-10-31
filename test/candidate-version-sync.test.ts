import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncCandidateVersion } from '../scripts/sync-candidate-version.mjs';

const roots: string[] = [];
const paths = [
  'package.json', 'package-lock.json', 'desktop/package.json',
  'desktop/src-tauri/tauri.conf.json', 'desktop/src-tauri/Cargo.toml', 'desktop/src-tauri/Cargo.lock',
  'server.json',
  'CHANGELOG.md', '.github/workflows/release.yml',
  'desktop/README.md',
  'README.md', 'docs/QUICKSTART.md',
];
const read = (root: string, path: string) => readFileSync(join(root, path), 'utf8');
const json = (root: string, path: string) => JSON.parse(read(root, path));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'phantom-candidate-version-'));
  roots.push(root);
  mkdirSync(join(root, 'desktop/src-tauri'), { recursive: true });
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  const putJson = (path: string, value: unknown) => writeFileSync(join(root, path), `${JSON.stringify(value, null, 2)}\n`);
  putJson('package.json', { name: '@ashlr/phantom', version: '3.27.0', dependencies: { unrelated: '3.27.0' } });
  putJson('package-lock.json', { name: '@ashlr/phantom', version: '3.27.0', lockfileVersion: 3, packages: {
    '': { name: '@ashlr/phantom', version: '3.27.0', dependencies: { unrelated: '3.27.0' } },
    'node_modules/unrelated': { version: '3.27.0', integrity: 'preserve-me' },
  } });
  putJson('desktop/package.json', { name: 'ashlr-desktop', version: '3.27.0', devDependencies: { unrelated: '3.27.0' } });
  putJson('desktop/src-tauri/tauri.conf.json', { version: '3.27.0', app: { windows: [
    { label: 'main', url: 'http://127.0.0.1:7777/verse/?v=3.27.0&keep=yes#anchor' },
    { label: 'launch', url: 'index.html' },
  ] }, bundle: { shortDescription: 'Phantom — workbench' } });
  putJson('server.json', { name: 'io.github.ashlrai/phantom', version: '3.27.0', packages: [
    { registryType: 'npm', identifier: '@ashlr/phantom', version: '3.27.0', runtimeHint: 'npx' },
  ] });
  writeFileSync(join(root, 'desktop/src-tauri/Cargo.toml'), '[package]\nname = "ashlr-desktop"\nversion = "3.27.0" # own version\n\n[dependencies]\nunrelated = "3.27.0"\n');
  writeFileSync(join(root, 'desktop/src-tauri/Cargo.lock'), '# Locked dependencies\nversion = 4\n\n[[package]]\nname = "unrelated"\nversion = "3.27.0"\nchecksum = "preserve-me"\n\n[[package]]\nname = "ashlr-desktop"\nversion = "3.27.0"\ndependencies = ["unrelated"]\n');
  writeFileSync(join(root, 'CHANGELOG.md'), '## [3.27.0] — historical published release\n');
  writeFileSync(join(root, '.github/workflows/release.yml'), '# frozen 3.3.2\n');
  writeFileSync(join(root, 'desktop/README.md'), 'This source tree targets version 3.27.0; check canonical release availability and exact matching assets before installation.\n\nThe published 3.27.0 release is historical.\n');
  for (const path of ['README.md', 'docs/QUICKSTART.md']) writeFileSync(join(root, path), 'This source tree targets version 3.27.0; check canonical release availability and exact matching assets before installation.\n\nThe published 3.27.0 release is historical.\n');
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('candidate version synchronization', () => {
  it('parses exactly one candidate field in the repository README and preserves surrounding prose', () => {
    const root = fixture();
    const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
    syncCandidateVersion(root, version);
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    writeFileSync(join(root, 'README.md'), readme);

    expect(syncCandidateVersion(root, undefined, { check: true }).matches).toBe(true);
    expect(read(root, 'README.md')).toBe(readme);
    const nextVersion = `${Number(version.split('.')[0]) + 1}.0.0`;
    syncCandidateVersion(root, nextVersion);
    expect(read(root, 'README.md')).toBe(readme.replace(
      `This source tree targets version ${version};`,
      `This source tree targets version ${nextVersion};`,
    ));
    expect(syncCandidateVersion(root, nextVersion, { check: true }).matches).toBe(true);
  });

  it('derives only read-only checks from the root and reports CLI drift without editing', () => {
    const root = fixture();
    mkdirSync(join(root, 'scripts'));
    copyFileSync(new URL('../scripts/sync-candidate-version.mjs', import.meta.url), join(root, 'scripts/sync-candidate-version.mjs'));
    expect(syncCandidateVersion(root, undefined, { check: true }).matches).toBe(true);
    const desktop = json(root, 'desktop/package.json'); desktop.version = '3.26.0';
    writeFileSync(join(root, 'desktop/package.json'), `${JSON.stringify(desktop, null, 2)}\n`);
    const before = paths.map((path) => read(root, path));
    const check = spawnSync(process.execPath, [join(root, 'scripts/sync-candidate-version.mjs'), '--check'], { encoding: 'utf8' });
    expect(check.status).toBe(1);
    expect(JSON.parse(check.stdout)).toMatchObject({ version: '3.27.0', check: true, matches: false, changed: ['desktop/package.json'] });
    const missing = spawnSync(process.execPath, [join(root, 'scripts/sync-candidate-version.mjs')], { encoding: 'utf8' });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('Usage:');
    expect(() => syncCandidateVersion(root, undefined)).toThrow(/canonical release version/);
    expect(paths.map((path) => read(root, path))).toEqual(before);
  }, 5_000);

  it('checks without edits, synchronizes only candidate identities, then checks idempotently', () => {
    const root = fixture();
    const before = paths.map((path) => read(root, path));
    const check = syncCandidateVersion(root, '3.28.0', { check: true });
    expect(check.matches).toBe(false);
    expect(check.changed).toHaveLength(10);
    expect(paths.map((path) => read(root, path))).toEqual(before);
    expect(syncCandidateVersion(root, '3.28.0').changed).toHaveLength(10);
    for (const path of ['package.json', 'package-lock.json', 'desktop/package.json', 'desktop/src-tauri/tauri.conf.json', 'server.json']) {
      expect(json(root, path).version).toBe('3.28.0');
    }
    expect(json(root, 'server.json').packages[0].version).toBe('3.28.0');
    expect(json(root, 'package-lock.json').packages[''].version).toBe('3.28.0');
    expect(json(root, 'package-lock.json').packages['node_modules/unrelated']).toEqual({ version: '3.27.0', integrity: 'preserve-me' });
    expect(json(root, 'package.json').dependencies.unrelated).toBe('3.27.0');
    expect(json(root, 'desktop/package.json').devDependencies.unrelated).toBe('3.27.0');
    const tauri = json(root, 'desktop/src-tauri/tauri.conf.json');
    expect(tauri.app.windows[0].url).toBe('http://127.0.0.1:7777/verse/?v=3.28.0&keep=yes#anchor');
    expect(tauri.app.windows[1].url).toBe('index.html');
    expect(read(root, 'desktop/src-tauri/Cargo.toml')).toContain('version = "3.28.0" # own version');
    expect(read(root, 'desktop/src-tauri/Cargo.toml')).toContain('unrelated = "3.27.0"');
    expect(read(root, 'desktop/src-tauri/Cargo.lock')).toContain('name = "unrelated"\nversion = "3.27.0"\nchecksum = "preserve-me"');
    expect(read(root, 'desktop/src-tauri/Cargo.lock')).toContain('name = "ashlr-desktop"\nversion = "3.28.0"');
    expect(read(root, 'CHANGELOG.md')).toBe(before[7]);
    expect(read(root, '.github/workflows/release.yml')).toBe(before[8]);
    expect(read(root, 'desktop/README.md')).toContain('This source tree targets version 3.28.0;');
    expect(read(root, 'desktop/README.md')).toContain('The published 3.27.0 release is historical.');
    for (const path of ['README.md', 'docs/QUICKSTART.md']) {
      expect(read(root, path)).toContain('This source tree targets version 3.28.0;');
      expect(read(root, path)).toContain('The published 3.27.0 release is historical.');
    }
    const synced = paths.map((path) => read(root, path));
    expect(syncCandidateVersion(root, '3.28.0').changed).toEqual([]);
    expect(syncCandidateVersion(root, '3.28.0', { check: true }).matches).toBe(true);
    expect(paths.map((path) => read(root, path))).toEqual(synced);
  });

  it.each(['v3.28.0', '03.28.0', '3.028.0', '3.28', '3.28.0-rc.1', '3.28.0+build', '3.28.0\n', '', '../3.28.0'])('rejects noncanonical release version %j before writing', (version) => {
    const root = fixture();
    const before = paths.map((path) => read(root, path));
    expect(() => syncCandidateVersion(root, version)).toThrow(/canonical release version/);
    expect(paths.map((path) => read(root, path))).toEqual(before);
  });

  it('refuses ambiguous own Cargo identities before any candidate file is written', () => {
    const root = fixture();
    const lockPath = join(root, 'desktop/src-tauri/Cargo.lock');
    writeFileSync(lockPath, `${read(root, 'desktop/src-tauri/Cargo.lock')}\n[[package]]\nname = "ashlr-desktop"\nversion = "3.27.0"\n`);
    const before = paths.map((path) => read(root, path));
    expect(() => syncCandidateVersion(root, '3.28.0')).toThrow(/one ashlr-desktop entry/);
    expect(paths.map((path) => read(root, path))).toEqual(before);
  });

  it.each(['desktop/README.md', 'README.md', 'docs/QUICKSTART.md'].flatMap((path) => ['missing', 'duplicate'].map((mutation) => [path, mutation])))('refuses %s %s candidate documentation before any metadata is written', (relativePath, mutation) => {
    const root = fixture();
    const path = join(root, relativePath);
    const original = read(root, relativePath);
    writeFileSync(path, mutation === 'missing' ? 'No candidate marker.\n' : `${original}\n${original}`);
    const before = paths.map((file) => read(root, file));
    expect(() => syncCandidateVersion(root, '3.28.0')).toThrow(/candidate documentation/);
    expect(paths.map((file) => read(root, file))).toEqual(before);
  });

  it('refuses wrong package identities and a nonlocal or duplicate version URL without editing', () => {
    for (const mutation of ['identity', 'remote', 'duplicate']) {
      const root = fixture();
      const path = mutation === 'identity' ? 'package.json' : 'desktop/src-tauri/tauri.conf.json';
      const value = json(root, path);
      if (mutation === 'identity') value.name = '@someone/else';
      else value.app.windows[0].url = mutation === 'remote' ? 'https://example.com/verse/?v=3.27.0' : 'http://127.0.0.1:7777/verse/?v=3.27.0&v=3.27.0';
      writeFileSync(join(root, path), `${JSON.stringify(value, null, 2)}\n`);
      const before = paths.map((file) => read(root, file));
      expect(() => syncCandidateVersion(root, '3.28.0')).toThrow();
      expect(paths.map((file) => read(root, file))).toEqual(before);
    }
  });

  it('refuses an MCP registry manifest that is not the Phantom npm package, without editing', () => {
    for (const mutate of [
      (manifest: { name: string }) => { manifest.name = 'io.github.someone/else'; },
      (manifest: { packages: { identifier: string }[] }) => { manifest.packages[0].identifier = '@someone/else'; },
      (manifest: { packages: { registryType: string }[] }) => { manifest.packages[0].registryType = 'oci'; },
    ]) {
      const root = fixture();
      const manifest = json(root, 'server.json');
      mutate(manifest);
      writeFileSync(join(root, 'server.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      const before = paths.map((file) => read(root, file));
      expect(() => syncCandidateVersion(root, '3.28.0')).toThrow(/MCP registry manifest/);
      expect(paths.map((file) => read(root, file))).toEqual(before);
    }
  });
});
