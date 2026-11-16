import * as fs from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import * as nodeUrl from 'node:url';
import * as os from 'node:os';
import { create as createTar } from 'tar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyCliReleaseUpdate, isReleaseDirectory, newerCliVersion, parseCliRelease, publishedNpmVersion } from '../src/core/cli-release-update.js';
import { cmdUpdate, detectChannel } from '../src/cli/update.js';

const child = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:url', async () => ({ ...await vi.importActual<typeof import('node:url')>('node:url') }));
vi.mock('node:os', async () => ({ ...await vi.importActual<typeof import('node:os')>('node:os') }));
vi.mock('node:child_process', async () => ({ ...await vi.importActual<typeof import('node:child_process')>('node:child_process'), spawnSync: child.spawn }));
vi.mock('../src/core/daemon/service.js', () => ({ serviceStatus: vi.fn(() => ({ running: false, registrationState: 'absent' })) }));
vi.mock('../src/cli/dashboard.js', () => ({ queryServeService: vi.fn(() => ({ running: false, registrationState: 'absent' })) }));

const OLD = 'a'.repeat(40), NEXT = 'b'.repeat(40), VERSION = '3.30.40';
let home: string, root: string, destination: string, archive: Buffer;
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
function write(path: string, text: string, mode = 0o600): void {
  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); fs.writeFileSync(path, text, { mode });
}
function metadata() {
  return { tag_name: `v${VERSION}`, target_commitish: NEXT, draft: false, prerelease: false,
    assets: [{ name: `ashlr-phantom-${VERSION}.tgz`, state: 'uploaded', size: archive.length, digest: `sha256:${hash(archive)}`,
      browser_download_url: `https://github.com/ashlrai/phantom/releases/download/v${VERSION}/ashlr-phantom-${VERSION}.tgz` }] };
}
function options() {
  return { home, root, release: parseCliRelease(metadata(), '@ashlr/phantom'), packageName: '@ashlr/phantom', assertServicesAbsent: vi.fn() };
}
function pointer(name = 'phm'): string { return join(home, '.local/bin', name); }
beforeEach(async () => {
  home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'phm-cli-release-')));
  root = join(home, '.local/share/ashlr/releases', OLD); destination = join(dirname(root), NEXT);
  write(join(root, 'bin/ashlr'), 'old');
  write(join(root, 'package.json'), JSON.stringify({ name: '@ashlr/phantom', version: '3.30.39' }));
  fs.mkdirSync(join(home, '.local/bin'), { recursive: true, mode: 0o700 });
  fs.symlinkSync(join(root, 'bin/ashlr'), pointer()); fs.symlinkSync(join(root, 'bin/ashlr'), pointer('ashlr'));
  const source = join(home, 'fixture/package');
  const files = {
    'package.json': JSON.stringify({ name: '@ashlr/phantom', version: VERSION, type: 'module', bin: { ashlr: 'bin/ashlr' } }),
    'dist/build-identity.json': JSON.stringify({ schemaVersion: 1, packageVersion: VERSION, revision: NEXT, dirty: false, provenance: 'git' }),
    'bin/ashlr': '#!/usr/bin/env node\nconsole.log("fixture help");',
    'dist/cli/index.js': 'export {};', 'dist/core/universe/index.js': 'export {};',
  };
  for (const [name, text] of Object.entries(files)) write(join(source, name), text, name === 'bin/ashlr' ? 0o700 : 0o600);
  const artifact = join(home, 'fixture.tgz');
  await createTar({ cwd: dirname(source), file: artifact, gzip: true, portable: true, noPax: true, noDirRecurse: true }, Object.keys(files).map(name => relative(dirname(source), join(source, name))));
  archive = fs.readFileSync(artifact);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(archive)));
  child.spawn.mockReset().mockReturnValue({ status: 0 });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); fs.rmSync(home, { recursive: true, force: true }); });

describe('release directory updates', () => {
  it.each([false, true])('routes the installed CLI end to end (check=%s), without git or npm', async check => {
    const actualUrlToPath = nodeUrl.fileURLToPath;
    vi.spyOn(nodeUrl, 'fileURLToPath').mockImplementation((url, opts) => String(url).endsWith('/src/cli/update.ts') ? join(root, 'dist/cli/update.js') : actualUrlToPath(url, opts));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.stubGlobal('fetch', vi.fn(async url => new Response(String(url).startsWith('https://api.github.com/') ? JSON.stringify(metadata()) : archive)));
    const output: string[] = []; vi.spyOn(console, 'log').mockImplementation(line => { output.push(String(line)); });
    expect(await cmdUpdate(['--yes', '--json', ...(check ? ['--check'] : [])])).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({ channel: 'release', updated: !check, versionLatest: VERSION });
    expect(child.spawn.mock.calls.every(call => call[0] === process.execPath)).toBe(true);
    expect(fs.realpathSync(pointer())).toBe(join(check ? root : destination, 'bin/ashlr'));
    if (check) { expect(child.spawn).not.toHaveBeenCalled(); expect(fs.existsSync(destination)).toBe(false); }
  });
  it('detects release layout before git and npm, without accepting arbitrary directories', async () => {
    expect(isReleaseDirectory(root, home)).toBe(true);
    expect(isReleaseDirectory(join(home, 'releases', OLD), home)).toBe(false);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    expect(detectChannel(pathToFileURL(join(root, 'dist/cli/update.js')).href)).toBe('release');
  });
  it('checks hashes, extracts and smoke-tests, updates both aliases and keeps rollback bytes with one log row', async () => {
    const opts = options(); expect(await applyCliReleaseUpdate(opts)).toBe(destination);
    expect(fs.realpathSync(pointer())).toBe(join(destination, 'bin/ashlr'));
    expect(fs.realpathSync(pointer('ashlr'))).toBe(join(destination, 'bin/ashlr'));
    expect(fs.readFileSync(join(root, 'bin/ashlr'), 'utf8')).toBe('old');
    expect(opts.assertServicesAbsent).toHaveBeenCalledTimes(2);
    expect(child.spawn.mock.calls[0]?.[1][1]).toBe('help');
    const rows = fs.readFileSync(join(home, '.ashlr-runs/installs.log'), 'utf8').trim().split('\n');
    expect(rows).toHaveLength(1); expect(JSON.parse(rows[0]!)).toMatchObject({ revision: NEXT, previous: OLD, sha256: hash(archive) });
    expect(fs.readdirSync(dirname(root))).toEqual(expect.arrayContaining([OLD, NEXT]));
  });
  it('atomically switches current and preserves aliases pointing through current', async () => {
    const current = join(home, '.local/share/ashlr/current'); fs.symlinkSync(root, current);
    for (const name of ['phm', 'ashlr']) { fs.unlinkSync(pointer(name)); fs.symlinkSync(join(current, 'bin/ashlr'), pointer(name)); }
    await applyCliReleaseUpdate(options());
    expect(fs.readlinkSync(current)).toBe(destination); expect(fs.readlinkSync(pointer())).toBe(join(current, 'bin/ashlr'));
    expect(fs.realpathSync(pointer())).toBe(join(destination, 'bin/ashlr'));
  });
  it.each(['checksum', 'smoke', 'service-race', 'pointer-race', 'log-symlink', 'existing-candidate'])('preserves the previous install on %s failure', async failure => {
    const opts = options();
    if (failure === 'checksum') vi.stubGlobal('fetch', vi.fn(async () => new Response(Buffer.alloc(archive.length))));
    if (failure === 'smoke') child.spawn.mockReturnValue({ status: 1 });
    if (failure === 'service-race') opts.assertServicesAbsent.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error('service appeared'); });
    if (failure === 'pointer-race') child.spawn.mockImplementation(() => { fs.unlinkSync(pointer('ashlr')); fs.symlinkSync('/unrelated', pointer('ashlr')); return { status: 0 }; });
    if (failure === 'log-symlink') { fs.mkdirSync(join(home, '.ashlr-runs')); fs.symlinkSync(join(home, 'private'), join(home, '.ashlr-runs/installs.log')); }
    if (failure === 'existing-candidate') { fs.mkdirSync(destination); write(join(destination, 'keep'), 'existing'); }
    await expect(applyCliReleaseUpdate(opts)).rejects.toThrow();
    expect(fs.realpathSync(pointer())).toBe(join(root, 'bin/ashlr'));
    expect(fs.readFileSync(join(root, 'bin/ashlr'), 'utf8')).toBe('old');
    expect(fs.readdirSync(dirname(root)).some(name => name.startsWith('.phm-'))).toBe(false);
    if (failure === 'existing-candidate') expect(fs.readFileSync(join(destination, 'keep'), 'utf8')).toBe('existing');
    else expect(fs.existsSync(destination)).toBe(false);
  });
  it('refuses a second updater without removing its lock', async () => {
    const lock = join(dirname(root), '.phm-update.lock'); fs.mkdirSync(lock);
    await expect(applyCliReleaseUpdate(options())).rejects.toThrow(); expect(fs.existsSync(lock)).toBe(true);
  });
  it.each(['digest', 'origin', 'duplicate', 'draft', 'revision'])('rejects incomplete or inconsistent release %s evidence', kind => {
    const data = metadata();
    if (kind === 'digest') data.assets[0]!.digest = '';
    if (kind === 'origin') data.assets[0]!.browser_download_url = 'https://example.com/package.tgz';
    if (kind === 'duplicate') data.assets.push(data.assets[0]!);
    if (kind === 'draft') data.draft = true;
    if (kind === 'revision') data.target_commitish = 'master';
    expect(() => parseCliRelease(data, '@ashlr/phantom')).toThrow();
  });
  it('does not downgrade or compare versions lexically', () => {
    expect(newerCliVersion('3.30.10', '3.30.9')).toBe(true);
    expect(newerCliVersion('3.30.9', '3.30.10')).toBe(false);
    expect(newerCliVersion(VERSION, VERSION)).toBe(false);
  });
});

describe('public registry probe', () => {
  it('reads public version metadata without a credential subprocess', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: VERSION }))));
    expect(await publishedNpmVersion('@ashlr/phantom')).toBe(VERSION);
    expect(fetch).toHaveBeenCalledWith('https://registry.npmjs.org/%40ashlr%2Fphantom/latest', expect.objectContaining({ credentials: 'omit', redirect: 'error' }));
    expect(child.spawn).not.toHaveBeenCalled();
  });
  it.each(['network', 'malformed', 'version', 'oversized'])('reports unknown on %s instead of installing', async failure => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (failure === 'network') throw new Error('offline');
      return new Response(failure === 'malformed' ? '{}' : failure === 'version' ? '{"version":"npm install evil"}' : 'x'.repeat(1024 * 1024 + 1));
    }));
    expect(await publishedNpmVersion('@ashlr/phantom')).toBeNull(); expect(child.spawn).not.toHaveBeenCalled();
  });
});
